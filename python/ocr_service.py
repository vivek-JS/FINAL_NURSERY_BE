"""
Local PaddleOCR microservice — FastAPI, models loaded once at startup and kept
warm in memory (never reloaded per request).

Run standalone (dev):
    python ocr_service.py
Run under pm2 (prod, see ../ecosystem.config.cjs):
    venv/bin/uvicorn ocr_service:app --host 127.0.0.1 --port 8010

Endpoints:
    GET  /health              -> { status, engines_loaded }
    POST /ocr (multipart "image") -> { success, text, lines, confidences, ms }

Design notes (see docs/local_paddleocr_service plan):
    - Two PaddleOCR engines are kept warm: "en" (Latin script + digits) and
      "devanagari" (Hindi + Marathi — PaddleOCR has no separate Marathi model;
      both languages share the Devanagari script and use the same model family).
    - Default PP-OCRv4 "mobile" models are used (we do not override
      det_model_dir/rec_model_dir), which are the lightweight variants —
      required given the 1 vCPU / ~2GB RAM production host.
    - Preprocessing is intentionally minimal: EXIF auto-rotate, deskew, and an
      adaptive upscale for small screenshots. An earlier version also applied
      denoise + CLAHE contrast + sharpening (aimed at photographed paper
      receipts), but side-by-side testing against real UPI app screenshots
      showed that combination measurably *hurts* accuracy — these are crisp
      digital screenshots, not noisy photos, so denoising/sharpening mostly
      adds artifacts around already-clean anti-aliased text. Kept minimal.
    - A single asyncio.Lock serializes actual inference calls: PaddleOCR's C++
      backend is not guaranteed safe for concurrent calls from multiple threads,
      and there is only 1 CPU core available anyway (no parallelism to gain).
"""

import asyncio
import io
import logging
import time
from contextlib import asynccontextmanager

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [OCR] %(levelname)s %(message)s",
)
logger = logging.getLogger("ocr_service")

# Populated at startup by _load_engines(). Kept as module globals so they are
# loaded exactly once and reused for every request (never re-created per call).
_engines = {}
_engines_lock = asyncio.Lock()

MIN_IMAGE_DIMENSION = 20  # px — anything smaller is treated as an invalid/empty image
MAX_IMAGE_DIMENSION = 4000  # px — safety cap before resize, avoids pathological inputs
# Real UPI screenshots are sometimes saved/forwarded at very low resolution
# (seen as small as 139x363px in production). Upscale the shorter side up to
# this target so PP-OCR's recognizer has enough pixels per character to work
# with, capped by MAX_UPSCALE_FACTOR so we don't blow up tiny thumbnails.
TARGET_MIN_DIMENSION = 900
MAX_UPSCALE_FACTOR = 6.0


def _load_engines():
    """Instantiate both PaddleOCR engines once. Blocking (model load from disk)."""
    from paddleocr import PaddleOCR

    logger.info("Loading PaddleOCR engines (en, devanagari) — this happens once at startup...")
    t0 = time.time()
    engines = {
        "en": PaddleOCR(use_angle_cls=True, lang="en", show_log=False),
        # Devanagari script family covers Hindi and Marathi (no dedicated Marathi
        # model exists in PaddleOCR — both languages share this script/model).
        "devanagari": PaddleOCR(use_angle_cls=True, lang="devanagari", show_log=False),
    }
    logger.info(f"PaddleOCR engines loaded in {round((time.time() - t0) * 1000)}ms")
    return engines


@asynccontextmanager
async def lifespan(app: FastAPI):
    _engines.update(_load_engines())
    yield
    _engines.clear()


app = FastAPI(title="Local UPI Receipt OCR", lifespan=lifespan)


def _decode_image(image_bytes: bytes) -> np.ndarray:
    """Bytes -> BGR ndarray, applying EXIF-based rotation first (Pillow handles
    EXIF orientation far more reliably than raw OpenCV decoding)."""
    if not image_bytes:
        raise ValueError("Empty image payload")
    try:
        pil_img = Image.open(io.BytesIO(image_bytes))
        pil_img = ImageOps.exif_transpose(pil_img)  # auto-rotate per EXIF tag
        pil_img = pil_img.convert("RGB")
    except Exception as exc:  # noqa: BLE001 - want to normalize all decode errors
        raise ValueError(f"Unsupported or corrupted image format: {exc}") from None

    arr = np.array(pil_img)
    img = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)

    h, w = img.shape[:2]
    if h < MIN_IMAGE_DIMENSION or w < MIN_IMAGE_DIMENSION:
        raise ValueError("Image is too small to contain readable text")
    return img


MAX_TRUSTED_SKEW_DEGREES = 15.0  # beyond this, treat the estimate as a false positive


def _deskew_angle(gray: np.ndarray) -> float:
    """Estimates skew in degrees (beyond the 0/90/180/270 EXIF rotation). Returns
    0.0 when there isn't enough foreground to estimate reliably, the angle is
    negligible, or the angle exceeds MAX_TRUSTED_SKEW_DEGREES.

    The Otsu-threshold + minAreaRect heuristic below is tuned for photographed
    paper documents (mostly-uniform background, one dominant text block). On
    busy digital UI screenshots (icons, multiple colored blocks) it can badly
    misfire — e.g. it returned -90 degrees on a real, perfectly upright UPI
    screenshot in testing, which then destroyed the whole image. Real UPI
    screenshots are digital renders and are never meaningfully skewed, so any
    large "detected" angle is far more likely a heuristic failure than real
    skew — clamping to a real photo-skew range avoids that regression.
    """
    thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)[1]
    coords = np.column_stack(np.where(thresh > 0))
    if coords.shape[0] < 20:
        return 0.0

    angle = cv2.minAreaRect(coords)[-1]
    if angle < -45:
        angle = -(90 + angle)
    else:
        angle = -angle
    if abs(angle) < 0.5 or abs(angle) > MAX_TRUSTED_SKEW_DEGREES:
        return 0.0
    return angle


def preprocess_image(image_bytes: bytes) -> np.ndarray:
    """Auto-rotate (EXIF) -> deskew -> adaptive upscale. Returns a 3-channel
    BGR ndarray. Deliberately does NOT denoise/contrast-boost/sharpen — see
    the module docstring for why that hurt real screenshot accuracy."""
    img = _decode_image(image_bytes)

    h, w = img.shape[:2]
    down_scale = min(1.0, MAX_IMAGE_DIMENSION / max(h, w))
    if down_scale < 1.0:
        img = cv2.resize(img, None, fx=down_scale, fy=down_scale, interpolation=cv2.INTER_AREA)
        h, w = img.shape[:2]

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    angle = _deskew_angle(gray)
    if angle:
        matrix = cv2.getRotationMatrix2D((w // 2, h // 2), angle, 1.0)
        img = cv2.warpAffine(
            img, matrix, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
        )

    up_scale = min(MAX_UPSCALE_FACTOR, max(1.0, TARGET_MIN_DIMENSION / min(h, w)))
    if up_scale > 1.0:
        img = cv2.resize(img, None, fx=up_scale, fy=up_scale, interpolation=cv2.INTER_CUBIC)

    return img


def _iou(box_a, box_b) -> float:
    """Intersection-over-union of two PaddleOCR quadrilateral boxes, approximated
    via their axis-aligned bounding rectangles (good enough for line dedup)."""
    ax = [p[0] for p in box_a]
    ay = [p[1] for p in box_a]
    bx = [p[0] for p in box_b]
    by = [p[1] for p in box_b]
    ax1, ay1, ax2, ay2 = min(ax), min(ay), max(ax), max(ay)
    bx1, by1, bx2, by2 = min(bx), min(by), max(bx), max(by)

    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0

    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _box_top(box) -> float:
    return min(p[1] for p in box)


def _run_engine(engine, img: np.ndarray, lang: str):
    """Runs one PaddleOCR engine and normalizes its output to a flat list of
    {box, text, confidence, lang} dicts."""
    raw = engine.ocr(img, cls=True)
    lines = []
    if not raw or not raw[0]:
        return lines
    for entry in raw[0]:
        if not entry or len(entry) < 2:
            continue
        box, text_info = entry[0], entry[1]
        text = text_info[0] if isinstance(text_info, (list, tuple)) else str(text_info)
        confidence = (
            float(text_info[1])
            if isinstance(text_info, (list, tuple)) and len(text_info) > 1
            else 1.0
        )
        text = (text or "").strip()
        if text:
            lines.append({"box": box, "text": text, "confidence": confidence, "lang": lang})
    return lines


def merge_multilang_lines(en_lines, dev_lines):
    """Dedupes overlapping detections between the two language passes, keeping
    the higher-confidence read per region, then sorts top-to-bottom to
    approximate the original reading order."""
    merged = list(en_lines)
    for dev_line in dev_lines:
        overlap = None
        for i, existing in enumerate(merged):
            if _iou(existing["box"], dev_line["box"]) > 0.5:
                overlap = i
                break
        if overlap is None:
            merged.append(dev_line)
        elif dev_line["confidence"] > merged[overlap]["confidence"]:
            merged[overlap] = dev_line

    merged.sort(key=lambda item: _box_top(item["box"]))
    return merged


@app.get("/health")
async def health():
    return {"status": "ok", "engines_loaded": sorted(_engines.keys())}


def _run_ocr_sync(image_bytes: bytes):
    """Blocking pipeline: preprocess + run both engines + merge. Executed in a
    worker thread (see /ocr handler) so the event loop stays responsive."""
    t_pre_start = time.time()
    processed = preprocess_image(image_bytes)
    preprocess_ms = round((time.time() - t_pre_start) * 1000)

    t_ocr_start = time.time()
    en_lines = _run_engine(_engines["en"], processed, "en")
    dev_lines = _run_engine(_engines["devanagari"], processed, "devanagari")
    ocr_ms = round((time.time() - t_ocr_start) * 1000)

    merged = merge_multilang_lines(en_lines, dev_lines)
    lines = [item["text"] for item in merged]
    confidences = [round(item["confidence"], 4) for item in merged]
    text = "\n".join(lines)

    avg_confidence = round(sum(confidences) / len(confidences), 4) if confidences else 0.0
    logger.info(
        f"OCR done: preprocess={preprocess_ms}ms inference={ocr_ms}ms "
        f"lines={len(lines)} avg_confidence={avg_confidence}"
    )
    return text, lines, confidences


@app.post("/ocr")
async def ocr_endpoint(image: UploadFile = File(...)):
    t0 = time.time()
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image uploads are supported")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Uploaded image is empty")

    if not _engines:
        raise HTTPException(status_code=503, detail="OCR engines are not ready yet")

    try:
        async with _engines_lock:
            loop = asyncio.get_event_loop()
            text, lines, confidences = await loop.run_in_executor(
                None, _run_ocr_sync, image_bytes
            )
    except ValueError as exc:
        # Bad/corrupted/too-small image — client error, not a server failure.
        logger.warning(f"Rejected image: {exc}")
        raise HTTPException(status_code=422, detail=str(exc)) from None
    except Exception as exc:  # noqa: BLE001 - normalize all engine failures
        logger.error(f"OCR pipeline failed: {exc}")
        raise HTTPException(status_code=500, detail="OCR processing failed") from None

    ms = round((time.time() - t0) * 1000)
    return JSONResponse(
        {"success": True, "text": text, "lines": lines, "confidences": confidences, "ms": ms}
    )


if __name__ == "__main__":
    import os

    import uvicorn

    port = int(os.environ.get("OCR_PY_PORT", 8010))
    uvicorn.run("ocr_service:app", host="127.0.0.1", port=port, workers=1)
