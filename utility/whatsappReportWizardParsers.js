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
    /\b(booking|delivery|availability|avail|nursery|बुकिंग|डिलिव्हरी|उपलब्ध)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (/\bbooking\s+report\b/i.test(l) || /\bdelivery\s+report\b/i.test(l)) {
    return true;
  }
  if (/\b(flow\s+report|report\s+flow)\b/i.test(l)) {
    return true;
  }
  return false;
}

export function guessReportTypeFromText(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(availability|avail|stock|उपलब्ध)\b/.test(t)) {
    return "availability";
  }
  if (/\b(delivery|डिलिव्हरी)\b/.test(t)) {
    return "delivery";
  }
  if (/\b(booking|बुकिंग)\b/.test(t)) {
    return "booking";
  }
  return null;
}

/** @returns {'booking'|'delivery'|'availability'|null} */
export function parseReportTypeChoice(text) {
  const t = String(text || "").trim().toLowerCase();
  if (["1", "1.", "one", "booking", "b"].includes(t) || t === "बुकिंग") {
    return "booking";
  }
  if (["2", "2.", "two", "delivery"].includes(t) || t === "डिलिव्हरी") {
    return "delivery";
  }
  if (
    ["3", "3.", "three", "availability", "avail", "stock"].includes(t) ||
    t === "उपलब्ध"
  ) {
    return "availability";
  }
  return null;
}

/** @returns {'by_plant'|'by_month'|null} */
export function parseAvailabilityModeChoice(text) {
  const t = String(text || "").trim().toLowerCase();
  if (["1", "1.", "one", "plant", "by plant", "crop"].includes(t)) {
    return "by_plant";
  }
  if (["2", "2.", "two", "month", "by month"].includes(t)) {
    return "by_month";
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

/**
 * Delivery planning window (IST): today, next 7 days, this month, next month, or custom.
 * @returns {{ ok: boolean, range?: { start: Date, end: Date }, pendingCustom?: boolean, label?: string }}
 */
export function parseDeliveryWindowChoice(text) {
  const t = String(text || "").trim().toLowerCase();
  const today = moment().utcOffset(330);
  if (["1", "1.", "one", "today", "today only", "आज"].includes(t)) {
    const start = today.clone().startOf("day").toDate();
    const end = today.clone().endOf("day").toDate();
    return { ok: true, range: { start, end }, label: "Today" };
  }
  if (
    ["2", "2.", "two", "7", "7 days", "next 7", "next seven", "week"].includes(t)
  ) {
    const start = today.clone().startOf("day").toDate();
    const end = today.clone().add(6, "day").endOf("day").toDate();
    return { ok: true, range: { start, end }, label: "Next 7 days" };
  }
  if (
    [
      "3",
      "3.",
      "three",
      "this month",
      "month",
      "current month",
      "this mnth",
    ].includes(t)
  ) {
    const start = today.clone().startOf("month").startOf("day").toDate();
    const end = today.clone().endOf("month").endOf("day").toDate();
    return { ok: true, range: { start, end }, label: "This month" };
  }
  if (
    ["4", "4.", "four", "next month", "nextmonth", "next mnth"].includes(t)
  ) {
    const nm = today.clone().add(1, "month");
    const start = nm.clone().startOf("month").startOf("day").toDate();
    const end = nm.clone().endOf("month").endOf("day").toDate();
    return { ok: true, range: { start, end }, label: "Next month" };
  }
  if (["5", "5.", "five", "custom", "range", "दिनांक"].includes(t)) {
    return { ok: true, pendingCustom: true };
  }

  const custom = parseCustomRangeText(text);
  if (custom) {
    return { ok: true, range: custom };
  }

  return { ok: false };
}

/**
 * @returns {{ ok: boolean, mode?: 'due_in_window'|'no_due'|'both' }}
 */
export function parseDeliveryDueFilterChoice(text) {
  const t = String(text || "").trim().toLowerCase();
  if (
    ["1", "1.", "one", "due", "with due", "scheduled", "a"].includes(t)
  ) {
    return { ok: true, mode: "due_in_window" };
  }
  if (
    ["2", "2.", "two", "no due", "without due", "not set", "b"].includes(t)
  ) {
    return { ok: true, mode: "no_due" };
  }
  if (["3", "3.", "three", "both", "all", "c"].includes(t)) {
    return { ok: true, mode: "both" };
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
