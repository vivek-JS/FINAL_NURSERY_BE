import { extractUpiFromImage } from "../services/gemini.service.js";

const AMOUNT_NUMERIC = /^\d+(\.\d+)?$/;
const ALLOWED_STATUS = new Set(["SUCCESS", "FAILED", "PENDING"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;

function toNullIfEmpty(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s === "" ? null : s;
}

function cleanAmount(raw) {
  if (raw == null) return null;
  let s = String(raw)
    .replace(/₹/g, "")
    .replace(/,/g, "")
    .trim();
  if (s === "") return null;
  return s;
}

function cleanUtr(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/\s/g, "");
  return s === "" ? null : s;
}

function assertFetchableImageUrl(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    throw new Error("Invalid image URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) image URLs are allowed");
  }
  const host = u.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal" ||
    host === "169.254.169.254";
  if (blocked) {
    throw new Error("This image URL is not allowed");
  }
}

async function fetchImageBufferFromUrl(imageUrl) {
  assertFetchableImageUrl(imageUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(imageUrl, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "NurseryBE-UPI-OCR/1.0" },
    });
    if (!res.ok) {
      throw new Error(`Failed to download image (${res.status})`);
    }
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!ct.startsWith("image/")) {
      throw new Error("URL did not return an image (check content-type)");
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new Error("Image is too large (max 10MB)");
    }
    return { buffer: buf, mimeType: ct };
  } finally {
    clearTimeout(timer);
  }
}

function buildSuccessPayload(raw) {
  const name = toNullIfEmpty(raw.name);
  const amount = cleanAmount(raw.amount);
  const utr_number = cleanUtr(raw.utr_number);
  const transaction_id = toNullIfEmpty(raw.transaction_id);
  const date = toNullIfEmpty(raw.date);
  const time = toNullIfEmpty(raw.time);
  const statusRaw = toNullIfEmpty(raw.status);
  const status = statusRaw ? statusRaw.toUpperCase() : null;
  const app_name = toNullIfEmpty(raw.app_name);
  const raw_text = toNullIfEmpty(raw.raw_text);

  const is_valid_amount = amount != null && AMOUNT_NUMERIC.test(amount);
  const is_valid_utr = utr_number != null && utr_number.length > 8;
  const status_ok = status != null && ALLOWED_STATUS.has(status);

  const needs_review =
    amount == null ||
    utr_number == null ||
    !is_valid_amount ||
    !is_valid_utr ||
    !status_ok;

  return {
    name,
    amount,
    utr_number,
    transaction_id,
    date,
    time,
    status,
    app_name,
    raw_text,
    is_valid_amount,
    is_valid_utr,
    needs_review,
  };
}

function sendGeminiError(res, err) {
  console.error("OCR:", err?.message || err);
  const msg = String(err?.message || err);
  if (msg.includes("GEMINI_API_KEY") || msg.includes("not configured")) {
    return res.status(503).json({
      success: false,
      error: "OCR service is not configured (set GEMINI_API_KEY)",
    });
  }
  return res.status(502).json({
    success: false,
    error: msg.length > 200 ? "Failed to extract UPI receipt" : msg,
  });
}

export async function extractUpiReceipt(req, res) {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({
        success: false,
        error: 'Multipart form field "image" is required',
      });
    }

    const raw = await extractUpiFromImage(req.file.buffer, req.file.mimetype);
    return res.json({ success: true, data: buildSuccessPayload(raw) });
  } catch (err) {
    return sendGeminiError(res, err);
  }
}

export async function extractUpiReceiptByUrl(req, res) {
  try {
    const imageUrl = req.body?.imageUrl;
    if (!imageUrl || typeof imageUrl !== "string" || !imageUrl.trim()) {
      return res.status(400).json({
        success: false,
        error: 'JSON body must include string "imageUrl"',
      });
    }

    const { buffer, mimeType } = await fetchImageBufferFromUrl(imageUrl.trim());
    const raw = await extractUpiFromImage(buffer, mimeType);
    return res.json({ success: true, data: buildSuccessPayload(raw) });
  } catch (err) {
    if (err?.name === "AbortError") {
      return res.status(504).json({ success: false, error: "Timed out fetching image URL" });
    }
    const msg = String(err?.message || err);
    if (
      msg.includes("Invalid image URL") ||
      msg.includes("not allowed") ||
      msg.includes("Only http") ||
      msg.includes("Failed to download") ||
      msg.includes("did not return an image") ||
      msg.includes("too large")
    ) {
      return res.status(400).json({ success: false, error: msg });
    }
    return sendGeminiError(res, err);
  }
}
