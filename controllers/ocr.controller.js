import { extractUpiFromImage } from "../services/gemini.service.js";
import { runLocalOcr, LocalOcrError } from "../services/ocrService.js";
import { parseTransaction } from "../services/transactionParser.js";
import { devanagariToAsciiDigits } from "../utility/devanagariNumerals.js";
import { readUploadBufferFromUrl } from "../utils/localStorageUtils.js";

const AMOUNT_NUMERIC = /^\d+(\.\d+)?$/;
const ALLOWED_STATUS = new Set(["SUCCESS", "FAILED", "PENDING"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;
/** Local OCR ran fine but the image itself is invalid — don't waste a Gemini call. */
const UNSALVAGEABLE_STATUS = 422;

/** Some LLM JSON responses literally emit the strings "null"/"undefined"/"NaN"
 * instead of a true null when a schema field has no value — treat those the
 * same as empty. */
const LITERAL_NULLISH = new Set(["null", "undefined", "nan", "n/a", "none"]);

function toNullIfEmpty(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (s === "" || LITERAL_NULLISH.has(s.toLowerCase())) return null;
  return s;
}

function cleanAmount(raw) {
  const base = toNullIfEmpty(raw);
  if (base == null) return null;
  const s = devanagariToAsciiDigits(base).replace(/₹/g, "").replace(/,/g, "").trim();
  return s === "" ? null : s;
}

function cleanUtr(raw) {
  const base = toNullIfEmpty(raw);
  if (base == null) return null;
  const s = devanagariToAsciiDigits(base).replace(/\s/g, "");
  return s === "" ? null : s;
}

function cleanNumericText(raw) {
  const base = toNullIfEmpty(raw);
  if (base == null) return null;
  const s = devanagariToAsciiDigits(base).trim();
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
  const trimmed = String(imageUrl).trim();
  const local = readUploadBufferFromUrl(trimmed);
  if (local?.buffer?.length) {
    if (local.buffer.length > MAX_IMAGE_BYTES) {
      throw new Error("Image is too large (max 10MB)");
    }
    return local;
  }

  assertFetchableImageUrl(trimmed);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(trimmed, {
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

/** True once the parser found at least one field worth trusting — otherwise we
 * treat the local OCR pass as "no signal" and fall back to Gemini. */
function hasUsableParsedSignal(parsed) {
  return Boolean(
    parsed.utr ||
      parsed.transactionId ||
      parsed.amount != null ||
      parsed.date ||
      parsed.sender ||
      parsed.receiver ||
      parsed.upiId
  );
}

/** Normalizes Gemini's raw schema into the same canonical shape transactionParser
 * produces, so both OCR sources feed one shared response-building path. */
function mapGeminiToCanonical(raw) {
  const statusRaw = toNullIfEmpty(raw.status);
  const amountRaw = cleanAmount(raw.amount);
  const amount = amountRaw != null && AMOUNT_NUMERIC.test(amountRaw) ? Number(amountRaw) : null;
  return {
    utr: cleanUtr(raw.utr_number),
    transactionId: cleanNumericText(raw.transaction_id),
    amount,
    date: cleanNumericText(raw.date),
    time: cleanNumericText(raw.time),
    bank: null, // Gemini's prompt does not distinguish bank vs UPI app
    app: toNullIfEmpty(raw.app_name),
    sender: null,
    receiver: toNullIfEmpty(raw.name),
    status: statusRaw ? statusRaw.toUpperCase() : null,
    upiId: null,
    referenceNumber: null,
  };
}

/**
 * Runs local PaddleOCR + regex parsing first; falls back to Gemini when the
 * local service is unreachable/erroring or returns no usable signal.
 * Image-format errors (422 from the local service) are NOT retried against
 * Gemini — the image itself is the problem, not the OCR backend.
 * @returns {Promise<{ source: "local"|"gemini", ocrText: string, parsed: object }>}
 */
async function runOcrPipeline(buffer, mimeType) {
  try {
    const local = await runLocalOcr(buffer, mimeType);
    const parsed = parseTransaction(local);
    if (hasUsableParsedSignal(parsed)) {
      return { source: "local", ocrText: local.text, parsed };
    }
    console.warn("[OCR] Local pass returned no usable signal, falling back to Gemini");
  } catch (err) {
    if (err instanceof LocalOcrError && err.status === UNSALVAGEABLE_STATUS) {
      throw err;
    }
    console.warn(`[OCR] Local service failed (${err?.message || err}), falling back to Gemini`);
  }

  const geminiRaw = await extractUpiFromImage(buffer, mimeType);
  return {
    source: "gemini",
    ocrText: toNullIfEmpty(geminiRaw.raw_text) || "",
    parsed: mapGeminiToCanonical(geminiRaw),
  };
}

/** Builds the legacy Gemini-shaped `raw` object from the canonical parsed fields
 * so `buildSuccessPayload()` (and every existing FE consumer) keeps working. */
function canonicalToLegacyRaw(parsed, ocrText) {
  return {
    name: parsed.receiver || parsed.sender || null,
    amount: parsed.amount != null ? String(parsed.amount) : null,
    utr_number: parsed.utr || parsed.referenceNumber || null,
    transaction_id: parsed.transactionId || null,
    date: parsed.date || null,
    time: parsed.time || null,
    status: parsed.status || null,
    app_name: parsed.app || null,
    raw_text: ocrText || null,
  };
}

function buildSuccessPayload(raw) {
  const name = toNullIfEmpty(raw.name);
  const amount = cleanAmount(raw.amount);
  const utr_number = cleanUtr(raw.utr_number);
  const transaction_id = cleanNumericText(raw.transaction_id);
  const date = cleanNumericText(raw.date);
  const time = cleanNumericText(raw.time);
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

function sendOcrError(res, err) {
  console.error("OCR:", err?.message || err);
  const msg = String(err?.message || err);
  if (msg.includes("GEMINI_API_KEY") || msg.includes("not configured")) {
    return res.status(503).json({
      success: false,
      error: "OCR is unavailable (local service down and GEMINI_API_KEY not configured)",
    });
  }
  if (err instanceof LocalOcrError && err.status === UNSALVAGEABLE_STATUS) {
    return res.status(422).json({ success: false, error: msg });
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

    const { ocrText, parsed } = await runOcrPipeline(req.file.buffer, req.file.mimetype);
    return res.json({ success: true, data: buildSuccessPayload(canonicalToLegacyRaw(parsed, ocrText)) });
  } catch (err) {
    return sendOcrError(res, err);
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
    const { ocrText, parsed } = await runOcrPipeline(buffer, mimeType);
    return res.json({ success: true, data: buildSuccessPayload(canonicalToLegacyRaw(parsed, ocrText)) });
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
    return sendOcrError(res, err);
  }
}

/**
 * POST /api/v1/ocr/transaction — additive endpoint returning the richer
 * transaction schema directly (utr/amount/sender/receiver/status/bank),
 * independent of the legacy `upi-receipt*` response shape above.
 */
export async function extractTransactionFromReceipt(req, res) {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({
        success: false,
        error: 'Multipart form field "image" is required',
      });
    }

    const { ocrText, parsed } = await runOcrPipeline(req.file.buffer, req.file.mimetype);
    return res.json({
      success: true,
      ocrText: ocrText || "",
      transaction: {
        utr: parsed.utr || parsed.referenceNumber || "",
        transactionId: parsed.transactionId || "",
        amount: parsed.amount != null ? String(parsed.amount) : "",
        date: parsed.date || "",
        time: parsed.time || "",
        bank: parsed.bank || "",
        sender: parsed.sender || "",
        receiver: parsed.receiver || "",
        status: parsed.status || "",
        upiId: parsed.upiId || "",
      },
    });
  } catch (err) {
    return sendOcrError(res, err);
  }
}
