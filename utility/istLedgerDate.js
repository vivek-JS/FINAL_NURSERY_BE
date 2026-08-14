/**
 * Money ledger entryDate helpers — business dates in Asia/Kolkata.
 * Mongo still stores UTC Date; wall-clock / calendar days are IST.
 */
import moment from "moment";
import { istDayBoundsFromYmd } from "./istOrderDateStats.js";

export const LEDGER_IST_TZ = "Asia/Kolkata";

/** YYYY-MM-DD in IST for any Date / ISO string. */
export function toIstYmd(value) {
  if (!value) return "";
  const m = moment(value).utcOffset(330);
  if (!m.isValid()) return "";
  return m.format("YYYY-MM-DD");
}

/**
 * Normalize ledger entryDate for storage.
 * - Missing → now (true instant)
 * - Date-only / noon-UTC placeholders → IST start-of-day for that IST calendar date
 * - Real timestamps kept as-is (displayed in IST on UI)
 */
export function normalizeLedgerEntryDate(value) {
  if (value == null || value === "") return new Date();
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return new Date();

  const iso = d.toISOString();
  const isPlaceholder =
    /T00:00:00(\.000)?Z$/.test(iso) || /T12:00:00(\.000)?Z$/.test(iso);
  if (isPlaceholder) {
    const ymd = toIstYmd(d);
    if (ymd) return istDayBoundsFromYmd(ymd).start;
  }
  return d;
}

/**
 * Party payment/discount date:
 * - empty → now (so row is latest)
 * - calendar today (YYYY-MM-DD or equivalent IST day) → now (not midnight)
 * - older/future calendar day → IST start of that day
 */
export function resolvePartyAdjustEntryDate(value) {
  if (value == null || value === "") return new Date();
  const raw = String(value).trim();
  let ymd = "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) ymd = raw;
  else ymd = toIstYmd(value);
  if (!ymd) return new Date();
  const today = toIstYmd(new Date());
  if (ymd === today) return new Date();
  return istDayBoundsFromYmd(ymd).start;
}

/** True when stored entryDate is IST calendar start (midnight IST). */
export function isIstStartOfDayDate(value) {
  if (!value) return false;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  const ymd = toIstYmd(d);
  if (!ymd) return false;
  return d.getTime() === istDayBoundsFromYmd(ymd).start.getTime();
}

/**
 * Sort / display time for statement rows.
 * Date-only business dates (IST SOD) used to bury same-day SELL under real-time GRN/payments —
 * prefer createdAt when it falls on the same IST calendar day.
 */
export function ledgerEntrySortTime(entry) {
  const createdMs = new Date(entry?.createdAt || 0).getTime();
  const entryMs = new Date(entry?.entryDate || 0).getTime();
  if (entry?.metadata?.partyAdjustment || entry?.documentType === "Manual") {
    return Number.isFinite(createdMs) && createdMs > 0 ? createdMs : entryMs;
  }
  if (
    isIstStartOfDayDate(entry?.entryDate) &&
    Number.isFinite(createdMs) &&
    createdMs > 0 &&
    toIstYmd(entry.entryDate) === toIstYmd(entry.createdAt)
  ) {
    return createdMs;
  }
  if (Number.isFinite(entryMs) && entryMs > 0) return entryMs;
  return createdMs || 0;
}

/**
 * Document SELL / PURCHASE posting date:
 * same rules as party adjust so today’s B2B chemical/seed sells surface as latest.
 */
export function resolveDocumentLedgerEntryDate(value) {
  return resolvePartyAdjustEntryDate(value);
}

/** Format for logs / API labels. */
export function formatIstDateTime(value) {
  if (!value) return "";
  return moment(value).utcOffset(330).format("DD MMM YYYY, hh:mm A") + " IST";
}
