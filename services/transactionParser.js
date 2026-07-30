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

/** Real UTR/txn-id/reference codes always contain at least one digit; a
 * pure-letters capture (e.g. "Google") is almost always the OCR spilling
 * over into an unrelated duplicate label on the next line — see the
 * "Google transaction ID\n<real id>" case where two OCR passes produced
 * overlapping, non-deduped lines. This lookahead rejects those. */
const ALNUM_CODE = "(?=[0-9a-zA-Z]*\\d)[0-9a-zA-Z]{6,30}";

/** Reference-number label variants (UTR / RRN / Txn ID / Reference No), in
 * priority order — first match wins for `utr`. Accepts 6-30 digit or
 * alphanumeric codes to cover different bank formats. */
const UTR_LABEL_PATTERNS = [
  new RegExp(`utr\\s*(?:no\\.?|number)?\\s*[:\\-]?\\s*(${ALNUM_CODE})`, "i"),
  new RegExp(`rrn\\s*(?:no\\.?)?\\s*[:\\-]?\\s*(${ALNUM_CODE})`, "i"),
  new RegExp(`upi\\s*ref(?:erence)?(?:\\s*no\\.?)?\\s*[:\\-]?\\s*(${ALNUM_CODE})`, "i"),
  new RegExp(`reference\\s*(?:no\\.?|number)?\\s*[:\\-]?\\s*(${ALNUM_CODE})`, "i"),
];

const TRANSACTION_ID_LABEL_PATTERNS = [
  new RegExp(`transaction\\s*id\\s*[:\\-]?\\s*(${ALNUM_CODE})`, "i"),
  new RegExp(`txn\\s*id\\s*[:\\-]?\\s*(${ALNUM_CODE})`, "i"),
  new RegExp(`upi\\s*transaction\\s*id\\s*[:\\-]?\\s*(${ALNUM_CODE})`, "i"),
];

/** Fallback: a bare 12-30 digit run with no label — most UPI apps show this
 * for the UTR even without an explicit "UTR:" prefix (e.g. Google Pay). */
const BARE_LONG_DIGIT_RUN = /\b(\d{12,30})\b/;

const AMOUNT_PATTERNS = [
  /(?:paid|amount|total)\s*[:\-]?\s*₹\s*([0-9,]+(?:\.\d{1,2})?)/i,
  /₹\s*([0-9,]+(?:\.\d{1,2})?)/,
  /(?:rs\.?|inr)\s*([0-9,]+(?:\.\d{1,2})?)/i,
];
/** Last-resort fallback when the currency marker (₹/Rs/INR) itself gets
 * dropped/garbled by OCR (common on low-res screenshots — seen in production
 * where "Paid ₹90.00" was split into separate garbled lines, losing the ₹).
 * Indian amounts are shown with exactly 2 decimal places, which is a fairly
 * distinctive signature even without a currency marker. */
const BARE_DECIMAL_AMOUNT = /\b(\d{1,3}(?:,\d{2,3})*\.\d{2})\b/;
/** Lowest-priority fallback: comma-grouped whole rupee amounts with no paise
 * shown (e.g. "50,000" on a bank-transfer receipt where the ₹ symbol OCR'd
 * away entirely). Requires at least one comma group so it can't accidentally
 * match a bare transaction ID/phone number, which are never comma-grouped. */
const BARE_GROUPED_AMOUNT = /\b(\d{1,3}(?:,\d{2,3}){1,})\b/;

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
  const raw =
    firstMatch(AMOUNT_PATTERNS, text) ||
    text.match(BARE_DECIMAL_AMOUNT)?.[1] ||
    text.match(BARE_GROUPED_AMOUNT)?.[1];
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, "");
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Picks the dictionary entry with the most occurrences in the text rather
 * than the first pattern that matches at all. A bank/app name can appear
 * once incidentally inside an unrelated string (e.g. "icici" as a substring
 * of a VPA domain like "eazypay@icici") while the *actual* bank is stated
 * explicitly and repeatedly (e.g. "IDBI Bank" x3) — occurrence count is a
 * much stronger signal than array order for picking the right one. */
function extractDictionaryMatch(patterns, text) {
  let best = null;
  let bestCount = 0;
  for (const { name, pattern } of patterns) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    const count = (text.match(global) || []).length;
    if (count > bestCount) {
      bestCount = count;
      best = name;
    }
  }
  return best;
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
