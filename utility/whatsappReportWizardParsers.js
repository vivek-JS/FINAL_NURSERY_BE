import moment from "moment";
import { getISTRangeInclusive, getTodayRangeIST } from "../services/reportService.js";

/**
 * Pure helpers for WhatsApp report wizard (unit-tested).
 */

export function isReportEntry(text) {
  const t = String(text || "").trim();
  const l = t.toLowerCase();
  if (t.length > 100) {
    return false;
  }
  if (/रिपोर्ट|बुकिंग|डिलिव्हरी/.test(t)) {
    if (/रिपोर्ट|बुकिंग|डिलिव्हरी|मिळव|द्या|pahije/i.test(t)) {
      return true;
    }
  }
  if (
    /^(get\s+report|report\s*$|nursery\s+report|dashboard\s+report|ops\s+report)\b/i.test(
      l
    )
  ) {
    return true;
  }
  if (
    /\b(report|रिपोर्ट)\b/i.test(t) &&
    /\b(booking|delivery|sowing|nursery|बुकिंग|डिलिव्हरी)\b/i.test(t)
  ) {
    return true;
  }
  if (/\bbooking\s+report\b/i.test(l) || /\bdelivery\s+report\b/i.test(l)) {
    return true;
  }
  return false;
}

export function guessReportTypeFromText(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(sowing|पेरणी|sow)\b/.test(t)) {
    return "sowing";
  }
  if (/\b(delivery|dispatch|डिलिव्हरी)\b/.test(t)) {
    return "delivery";
  }
  if (/\b(booking|बुकिंग)\b/.test(t)) {
    return "booking";
  }
  return null;
}

export function parseReportTypeChoice(text) {
  const t = String(text || "").trim().toLowerCase();
  if (["1", "1.", "one", "booking", "b"].includes(t) || t === "बुकिंग") {
    return "booking";
  }
  if (
    ["2", "2.", "two", "delivery", "d", "dispatch"].includes(t) ||
    t === "डिलिव्हरी"
  ) {
    return "delivery";
  }
  if (["3", "3.", "three", "sowing", "s"].includes(t) || t === "पेरणी") {
    return "sowing";
  }
  return null;
}

/**
 * @returns {{ ok: boolean, range?: { start: Date, end: Date }, pendingCustom?: boolean }}
 */
export function parseDateChoice(text) {
  const t = String(text || "").trim().toLowerCase();
  if (["1", "1.", "one", "today", "today only", "आज"].includes(t)) {
    const { start, end } = getTodayRangeIST();
    return { ok: true, range: { start, end } };
  }
  if (["2", "2.", "yesterday", "काल"].includes(t)) {
    const y = moment().utcOffset(330).subtract(1, "day");
    const start = y.clone().startOf("day").toDate();
    const end = y.clone().endOf("day").toDate();
    return { ok: true, range: { start, end } };
  }
  if (["3", "3.", "week", "7", "7 days", "last week"].includes(t)) {
    const end = moment().utcOffset(330).endOf("day").toDate();
    const start = moment()
      .utcOffset(330)
      .subtract(6, "day")
      .startOf("day")
      .toDate();
    return { ok: true, range: { start, end } };
  }
  if (["4", "4.", "custom", "range", "दिनांक"].includes(t)) {
    return { ok: true, pendingCustom: true };
  }

  const custom = parseCustomRangeText(text);
  if (custom) {
    return { ok: true, range: custom };
  }

  return { ok: false };
}

export function parseCustomRangeText(text) {
  const raw = String(text || "").trim();
  const isoRange =
    raw.match(
      /(\d{4}-\d{2}-\d{2})\s*(?:to|through|til|until|–|-|वरून|ते)\s*(\d{4}-\d{2}-\d{2})/i
    );
  if (isoRange) {
    return getISTRangeInclusive(isoRange[1], isoRange[2]);
  }
  const dmyRange =
    raw.match(
      /(\d{2}-\d{2}-\d{4})\s*(?:to|through|–|-|ते)\s*(\d{2}-\d{2}-\d{4})/i
    );
  if (dmyRange) {
    const a = moment(dmyRange[1], "DD-MM-YYYY", true);
    const b = moment(dmyRange[2], "DD-MM-YYYY", true);
    if (a.isValid() && b.isValid()) {
      return getISTRangeInclusive(a, b);
    }
  }
  return null;
}
