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

/** Format for logs / API labels. */
export function formatIstDateTime(value) {
  if (!value) return "";
  return moment(value).utcOffset(330).format("DD MMM YYYY, hh:mm A") + " IST";
}
