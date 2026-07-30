/**
 * Regex-based extraction of UPI/bank transaction fields from OCR text.
 * Pure functions — no I/O — so this is unit-testable in isolation
 * (see scripts/test-ocr-samples.mjs).
 */

import { devanagariToAsciiDigits } from "../utility/devanagariNumerals.js";

/** UPI apps we recognize on screenshots (section 6 of the spec). */
export const UPI_APP_PATTERNS = [
  { name: "Google Pay", pattern: /\bg\s*-?\s*pay\b|\bgoogle\s*pay\b/i },
  { name: "PhonePe", pattern: /\bphone\s*pe\b/i },
  { name: "Paytm", pattern: /\bpaytm\b/i },
  { name: "BHIM", pattern: /\bbhim\b/i },
  { name: "Amazon Pay", pattern: /\bamazon\s*pay\b/i },
];

/** Banks we recognize on screenshots (section 6 of the spec). */
export const BANK_NAME_PATTERNS = [
  { name: "HDFC Bank", pattern: /\bhdfc\b/i },
  { name: "ICICI Bank", pattern: /\bicici\b/i },
  { name: "State Bank of India", pattern: /\bsbi\b|state\s*bank\s*of\s*india/i },
  { name: "Axis Bank", pattern: /\baxis\b/i },
  { name: "Kotak Mahindra Bank", pattern: /\bkotak\b/i },
  { name: "Canara Bank", pattern: /\bcanara\b/i },
  { name: "IDBI Bank", pattern: /\bidbi\b/i },
  { name: "Union Bank", pattern: /union\s*bank/i },
  { name: "Bank of Baroda", pattern: /bank\s*of\s*baroda|\bbob\b/i },
];

/** Reference-number label variants (UTR / RRN / Txn ID / Reference No), in
 * priority order — first match wins for `utr`. Accepts 6-30 digit or
 * alphanumeric codes to cover different bank formats. */
const UTR_LABEL_PATTERNS = [
  /utr\s*(?:no\.?|number)?\s*[:\-]?\s*([0-9a-zA-Z]{6,30})/i,
  /rrn\s*(?:no\.?)?\s*[:\-]?\s*([0-9a-zA-Z]{6,30})/i,
  /upi\s*ref(?:erence)?(?:\s*no\.?)?\s*[:\-]?\s*([0-9a-zA-Z]{6,30})/i,
  /reference\s*(?:no\.?|number)?\s*[:\-]?\s*([0-9a-zA-Z]{6,30})/i,
];

const TRANSACTION_ID_LABEL_PATTERNS = [
  /transaction\s*id\s*[:\-]?\s*([0-9a-zA-Z]{6,30})/i,
  /txn\s*id\s*[:\-]?\s*([0-9a-zA-Z]{6,30})/i,
  /upi\s*transaction\s*id\s*[:\-]?\s*([0-9a-zA-Z]{6,30})/i,
];

/** Fallback: a bare 12-30 digit run with no label — most UPI apps show this
 * for the UTR even without an explicit "UTR:" prefix (e.g. Google Pay). */
const BARE_LONG_DIGIT_RUN = /\b(\d{12,30})\b/;

const AMOUNT_PATTERNS = [
  /(?:paid|amount|total)\s*[:\-]?\s*₹\s*([0-9,]+(?:\.\d{1,2})?)/i,
  /₹\s*([0-9,]+(?:\.\d{1,2})?)/,
  /(?:rs\.?|inr)\s*([0-9,]+(?:\.\d{1,2})?)/i,
];

const DATE_PATTERNS = [
  // \s* (not \s+) between month and year tolerates OCR merging spaces, e.g. "Jul2026".
  /\b(\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{2,4})\b/i,
  /\b(\d{4}-\d{2}-\d{2})\b/,
  /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/,
  /\b(\d{1,2}-\d{1,2}-\d{2,4})\b/,
];

const TIME_PATTERN = /\b(\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|AM|PM)?)\b/;

const UPI_ID_PATTERN = /\b([a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64})\b/;
/** Excludes plain emails (support@bank.com) which match the same shape as a VPA. */
const EMAIL_LIKE_SUFFIX = /\.(com|in|org|net|co|gov)$/i;

const STATUS_PATTERNS = [
  { status: "FAILED", pattern: /failed|declined|unsuccessful|cancelled|not\s*completed/i },
  { status: "PENDING", pattern: /pending|processing|in\s*progress/i },
  { status: "SUCCESS", pattern: /success(?:ful)?|completed|payment\s*done/i },
];

const SENDER_LABELS = /^(from|received\s*from|payer)\s*[:\-]?\s*(.*)$/i;
const RECEIVER_LABELS = /^(to|paid\s*to|sent\s*to|payee)\s*[:\-]?\s*(.*)$/i;

/** A line that is itself just another label/amount/date is not a usable name value. */
function looksLikeMetadataLine(line) {
  if (!line) return true;
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^[₹\d.,\s]+$/.test(trimmed)) return true; // pure amount
  if (SENDER_LABELS.test(trimmed) || RECEIVER_LABELS.test(trimmed)) return true;
  if (/utr|rrn|reference|transaction\s*id|txn\s*id/i.test(trimmed)) return true;
  return false;
}

function toLines(input) {
  if (Array.isArray(input?.lines) && input.lines.length) {
    return input.lines.map((l) => devanagariToAsciiDigits(String(l))).filter(Boolean);
  }
  const text = typeof input?.text === "string" ? input.text : String(input || "");
  return devanagariToAsciiDigits(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function firstMatch(patterns, haystack) {
  for (const pattern of patterns) {
    const m = haystack.match(pattern);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function extractUtrAndTransactionId(text) {
  const utr = firstMatch(UTR_LABEL_PATTERNS, text);
  const transactionId = firstMatch(TRANSACTION_ID_LABEL_PATTERNS, text);
  if (utr || transactionId) {
    return { utr: utr || null, transactionId: transactionId || null };
  }
  // No labeled reference found anywhere — fall back to the first long digit run.
  const bare = text.match(BARE_LONG_DIGIT_RUN);
  return { utr: bare?.[1] || null, transactionId: null };
}

function extractAmount(text) {
  const raw = firstMatch(AMOUNT_PATTERNS, text);
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, "");
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function extractDictionaryMatch(patterns, text) {
  for (const { name, pattern } of patterns) {
    if (pattern.test(text)) return name;
  }
  return null;
}

function extractUpiId(text) {
  const m = text.match(UPI_ID_PATTERN);
  if (!m) return null;
  const domain = m[1].split("@")[1] || "";
  return EMAIL_LIKE_SUFFIX.test(domain) ? null : m[1];
}

function extractStatus(text) {
  for (const { status, pattern } of STATUS_PATTERNS) {
    if (pattern.test(text)) return status;
  }
  return null;
}

function extractSenderReceiver(lines) {
  let sender = null;
  let receiver = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const senderMatch = line.match(SENDER_LABELS);
    const receiverMatch = line.match(RECEIVER_LABELS);

    if (senderMatch && !sender) {
      const inline = senderMatch[2]?.trim();
      const next = lines[i + 1];
      sender = inline || (!looksLikeMetadataLine(next) ? next?.trim() : null) || null;
    }
    if (receiverMatch && !receiver) {
      const inline = receiverMatch[2]?.trim();
      const next = lines[i + 1];
      receiver = inline || (!looksLikeMetadataLine(next) ? next?.trim() : null) || null;
    }
  }
  return { sender, receiver };
}

/**
 * @param {{ text?: string, lines?: string[] }} ocrResult
 * @returns {{ utr: string|null, transactionId: string|null, amount: number|null,
 *   date: string|null, time: string|null, bank: string|null, app: string|null,
 *   sender: string|null, receiver: string|null, status: string|null,
 *   upiId: string|null, referenceNumber: string|null }}
 */
export function parseTransaction(ocrResult) {
  const lines = toLines(ocrResult);
  const text = lines.join("\n");

  const { utr, transactionId } = extractUtrAndTransactionId(text);
  const { sender, receiver } = extractSenderReceiver(lines);

  return {
    utr,
    transactionId,
    amount: extractAmount(text),
    date: firstMatch(DATE_PATTERNS, text),
    time: text.match(TIME_PATTERN)?.[1]?.trim() || null,
    bank: extractDictionaryMatch(BANK_NAME_PATTERNS, text),
    app: extractDictionaryMatch(UPI_APP_PATTERNS, text),
    sender,
    receiver,
    status: extractStatus(text),
    upiId: extractUpiId(text),
    // Kept distinct from `utr` for callers that want the raw labeled
    // "Reference No" value even when a separate UTR was also found.
    referenceNumber: firstMatch(UTR_LABEL_PATTERNS.slice(2, 3), text),
  };
}
