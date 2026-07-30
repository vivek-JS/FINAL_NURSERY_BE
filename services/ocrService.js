/**
 * Thin HTTP client for the local PaddleOCR microservice (see python/ocr_service.py).
 * The Python service keeps its models warm in memory; this client just forwards
 * image bytes and normalizes failures into a single typed error so callers
 * (ocr.controller.js) can fall back to Gemini without inspecting HTTP internals.
 */

const DEFAULT_SERVICE_URL = "http://127.0.0.1:8010";
// Measured on the 1 vCPU production host: two-engine inference alone takes
// ~2-3.6s, and can stretch further under CPU contention from other pm2 apps
// (e.g. WhatsApp/Puppeteer). 5s was too tight and caused spurious Gemini
// fallbacks; 9s balances that against not hanging requests indefinitely.
const REQUEST_TIMEOUT_MS = 9000;

/** Thrown for any local-OCR failure (service down, timeout, bad image, engine error). */
export class LocalOcrError extends Error {
  constructor(message, { cause, status } = {}) {
    super(message);
    this.name = "LocalOcrError";
    this.status = status ?? null;
    if (cause) this.cause = cause;
  }
}

function getServiceUrl() {
  return (process.env.PADDLEOCR_SERVICE_URL || DEFAULT_SERVICE_URL).replace(/\/+$/, "");
}

/**
 * Calls the local PaddleOCR service with raw image bytes.
 * @param {Buffer} buffer
 * @param {string} mimeType e.g. image/jpeg
 * @returns {Promise<{ text: string, lines: string[], confidences: number[], ms: number }>}
 */
export async function runLocalOcr(buffer, mimeType) {
  if (!buffer || !buffer.length) {
    throw new LocalOcrError("Empty image buffer");
  }

  const url = `${getServiceUrl()}/ocr`;
  const form = new FormData();
  const safeMime = mimeType && mimeType.startsWith("image/") ? mimeType : "image/jpeg";
  form.append("image", new Blob([buffer], { type: safeMime }), "receipt.jpg");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, { method: "POST", body: form, signal: ctrl.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new LocalOcrError(`Local OCR service timed out after ${REQUEST_TIMEOUT_MS}ms`, {
        cause: err,
      });
    }
    throw new LocalOcrError(`Local OCR service is unreachable (${url})`, { cause: err });
  } finally {
    clearTimeout(timer);
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    // fall through — handled below via !res.ok / missing json.success
  }

  if (!res.ok) {
    const detail = json?.detail || json?.error || `HTTP ${res.status}`;
    throw new LocalOcrError(`Local OCR service error: ${detail}`, { status: res.status });
  }
  if (!json?.success) {
    throw new LocalOcrError("Local OCR service returned an unsuccessful response");
  }

  return {
    text: typeof json.text === "string" ? json.text : "",
    lines: Array.isArray(json.lines) ? json.lines : [],
    confidences: Array.isArray(json.confidences) ? json.confidences : [],
    ms: typeof json.ms === "number" ? json.ms : null,
  };
}

/** Quick reachability check — used for optional startup/health diagnostics only. */
export async function isLocalOcrHealthy() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${getServiceUrl()}/health`, { signal: ctrl.signal }).finally(() =>
      clearTimeout(timer)
    );
    if (!res.ok) return false;
    const json = await res.json().catch(() => null);
    return Boolean(json?.status === "ok" && json?.engines_loaded?.length);
  } catch {
    return false;
  }
}
