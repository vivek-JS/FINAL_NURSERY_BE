"""
One-time model warm-up: instantiating PaddleOCR triggers its built-in
auto-download of the PP-OCRv4 mobile model bundles into the PaddleOCR cache
directory (~/.paddleocr by default). Run this once during setup so the
long-running service (ocr_service.py) never needs network access at boot
and the first real request isn't slowed down by a cold download.

Run with: venv/bin/python warm_models.py
"""

from paddleocr import PaddleOCR

print("Downloading/verifying PaddleOCR model bundle: en ...")
PaddleOCR(use_angle_cls=True, lang="en", show_log=False)

print("Downloading/verifying PaddleOCR model bundle: devanagari (Hindi/Marathi) ...")
PaddleOCR(use_angle_cls=True, lang="devanagari", show_log=False)

print("All PaddleOCR model bundles are cached and ready.")
