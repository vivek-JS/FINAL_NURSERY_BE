/**
 * Sowing machine clock times. Stored as 24h "HH:mm"; accepts "HH:mm" or "h:mm AM/PM".
 */

/** @returns {string|null} "HH:mm", or null when empty/invalid. */
export function parseClockTime(value) {
  const s = String(value ?? "").trim().toUpperCase();
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3];
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === "AM" && h === 12) h = 0;
    if (ampm === "PM" && h !== 12) h += 12;
  } else if (h > 23) {
    return null;
  }
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Minutes from start to end; an end before start is treated as past midnight. */
export function machineRunMinutes(start, end) {
  const a = parseClockTime(start);
  const b = parseClockTime(end);
  if (!a || !b) return 0;
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const diff = toMin(b) - toMin(a);
  return diff >= 0 ? diff : diff + 24 * 60;
}

/** "HH:mm" -> "h:mm AM/PM" (empty string when invalid). */
export function formatClock12h(value) {
  const t = parseClockTime(value);
  if (!t) return "";
  const h = Number(t.slice(0, 2));
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${t.slice(3)} ${suffix}`;
}

/**
 * Read machineStartTime / machineEndTime from a request body.
 * @returns {{ start: string, end: string, minutes: number } | { error: string }}
 */
export function readMachineTimes(body = {}) {
  const rawStart = String(body.machineStartTime ?? "").trim();
  const rawEnd = String(body.machineEndTime ?? "").trim();
  if (!rawStart && !rawEnd) return { start: "", end: "", minutes: 0 };
  const start = parseClockTime(rawStart);
  const end = parseClockTime(rawEnd);
  if (!start || !end) {
    return { error: "Machine start and end time are both required (HH:mm or h:mm AM/PM)" };
  }
  return { start, end, minutes: machineRunMinutes(start, end) };
}
