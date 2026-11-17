import { toSowYmd } from "../controllers/sowingSlotReadyHelpers.js";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function istTodayYmd(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function parseYmd(value) {
  const s = String(value || "").trim().slice(0, 10);
  return YMD_RE.test(s) ? s : "";
}

function nextYmd(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d));
  next.setUTCDate(next.getUTCDate() + 1);
  const ny = next.getUTCFullYear();
  const nm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const nd = String(next.getUTCDate()).padStart(2, "0");
  return `${ny}-${nm}-${nd}`;
}

/**
 * Half-open Asia/Kolkata range. from=to=YYYY-MM-DD is that full calendar day,
 * not an empty interval. End is the next day's midnight, exclusive.
 */
export function istHalfOpenRange(from, to) {
  const startYmd = parseYmd(from);
  const endYmd = parseYmd(to);
  if (!startYmd && !endYmd) return null;
  const range = {};
  if (startYmd) range.$gte = new Date(`${startYmd}T00:00:00+05:30`);
  if (endYmd) range.$lt = new Date(`${nextYmd(endYmd)}T00:00:00+05:30`);
  return range;
}

/** Inclusive YYYY-MM-DD string range used by view=entries. Equal bounds keep that day. */
export function sowDayStringRange(from, to) {
  const range = {};
  const start = parseYmd(from);
  const end = parseYmd(to);
  if (start) range.$gte = start;
  if (end) range.$lte = end;
  return Object.keys(range).length ? range : null;
}

export function readyYmdOf(item) {
  const raw =
    item?.affectedSlot?.plantReadyDate ||
    item?.plantReadyDate ||
    item?.readyDate ||
    "";
  const ymd = toSowYmd(raw);
  return parseYmd(ymd);
}

/** Calendar days from todayYmd to readyYmd in Asia/Kolkata dates. */
export function calendarDaysLeft(readyYmd, todayYmd) {
  const ready = parseYmd(readyYmd);
  const today = parseYmd(todayYmd);
  if (!ready || !today) return null;
  const [ry, rm, rd] = ready.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  const a = Date.UTC(ry, rm - 1, rd);
  const b = Date.UTC(ty, tm - 1, td);
  return Math.round((a - b) / 86400000);
}

function intQuery(value) {
  if (value == null || value === "") return null;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : null;
}

export function needsComputedEntryFilter(query = {}) {
  const excess = String(query.excessOnly || "").trim().toLowerCase();
  return Boolean(
    parseYmd(query.readyDate) ||
      excess === "true" ||
      excess === "1" ||
      intQuery(query.daysLeftGt) != null ||
      intQuery(query.daysLeftLt) != null ||
      String(query.sort || "") === "excess"
  );
}

export function entryMatchesFilters(item, query = {}, todayYmd = istTodayYmd()) {
  const readyDate = parseYmd(query.readyDate);
  const gt = intQuery(query.daysLeftGt);
  const lt = intQuery(query.daysLeftLt);
  const excessOn = ["true", "1"].includes(String(query.excessOnly || "").trim().toLowerCase());
  const ready = readyYmdOf(item);
  if (readyDate && ready !== readyDate) return false;
  if (excessOn && !(Number(item?.excessPlants) > 0)) return false;
  if (gt != null || lt != null) {
    if (!ready) return false;
    const left = calendarDaysLeft(ready, todayYmd);
    if (left == null) return false;
    if (gt != null && !(left > gt)) return false;
    if (lt != null && !(left < lt)) return false;
  }
  return true;
}

function sowSortKey(item) {
  return toSowYmd(item?.sowingDate || item?.sowingCompletedDate) || "";
}

export function sortEntryItems(items, sort = "sowDate", dir = "desc") {
  const sign = String(dir).toLowerCase() === "asc" ? 1 : -1;
  const byExcess = String(sort) === "excess";
  return items.slice().sort((a, b) => {
    if (byExcess) {
      const diff = (Number(a?.excessPlants) || 0) - (Number(b?.excessPlants) || 0);
      if (diff !== 0) return diff * sign;
    } else {
      const da = sowSortKey(a);
      const db = sowSortKey(b);
      if (da !== db) return da < db ? -sign : sign;
    }
    const ida = String(a?._id || "");
    const idb = String(b?._id || "");
    if (ida === idb) return 0;
    return ida < idb ? -1 : 1;
  });
}

export function pageEntryItems(items, page, limit) {
  const total = items.length;
  const start = Math.max(0, (page - 1) * limit);
  return {
    items: items.slice(start, start + limit),
    total,
    pages: Math.ceil(total / limit) || 0,
  };
}
