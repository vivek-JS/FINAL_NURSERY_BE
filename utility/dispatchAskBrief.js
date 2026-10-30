const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const TONES = new Set(["risk", "watch", "ok"]);
const MAX_INSIGHTS = 6;

export function parseYmd(value) {
  const match = YMD.exec(String(value || ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function addCalendarDays(ymd, days) {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${mm}-${dd}`;
}

/** Inclusive day count. 0 when the range is missing or backwards. */
export function inclusiveDays(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 86400000) + 1;
}

/**
 * Same length of days immediately before and after the range the desk selected.
 * A 30-day pick becomes 30 before + 30 selected + 30 after in the AI text.
 */
export function expandDispatchRange(from, to) {
  const focusFrom = parseYmd(from);
  const focusTo = parseYmd(to);
  const padDays = focusFrom && focusTo ? inclusiveDays(focusFrom, focusTo) : 0;
  if (!padDays) return null;
  return {
    focusFrom,
    focusTo,
    padDays,
    beforeFrom: addCalendarDays(focusFrom, -padDays),
    beforeTo: addCalendarDays(focusFrom, -1),
    afterFrom: addCalendarDays(focusTo, 1),
    afterTo: addCalendarDays(focusTo, padDays),
  };
}

const fmt = (value) => Math.round(Number(value) || 0).toLocaleString("en-IN");
const signed = (value) => {
  const n = Math.round(Number(value) || 0);
  if (!n) return "0";
  return `${n > 0 ? "+" : "−"}${fmt(Math.abs(n))}`;
};

function gapOf(row) {
  return Math.round((Number(row?.lagwad) || 0) - (Number(row?.dispatch) || 0));
}

function bookedPct(row) {
  const lagwad = Number(row?.lagwad) || 0;
  const dispatch = Number(row?.dispatch) || 0;
  if (lagwad > 0) return Math.round((dispatch / lagwad) * 100);
  return dispatch > 0 ? 100 : 0;
}

function windowLine(row) {
  return [
    `${row.from} to ${row.to}`,
    `bookings ${fmt(row.dispatch)}`,
    `orders ${fmt(row.orderCount)}`,
    `lagwad ${fmt(row.lagwad)}`,
    `ready ${fmt(row.readyLagwad)}`,
    `overdue ${fmt(row.overdueDispatch)}`,
    `gap ${signed(gapOf(row))}`,
    `booked ${bookedPct(row)}%`,
  ].join(" | ");
}

function sectionBlock(label, range, board) {
  const totals = board?.totals || {};
  const windows = board?.windows || [];
  const lines = windows.length ? windows.map(windowLine) : ["none"];
  return [
    `=== ${label} ${range.from} to ${range.to} ===`,
    ...lines,
    `TOTAL | bookings ${fmt(totals.dispatch)} | orders ${fmt(totals.orderCount)} | lagwad ${fmt(totals.lagwad)} | ready ${fmt(totals.readyLagwad)} | overdue ${fmt(totals.overdueDispatch)} | gap ${signed(gapOf(totals))} | booked ${bookedPct(totals)}%`,
  ].join("\n");
}

/** Plain-text brief. SELECTED is the screen; BEFORE and AFTER are context only. */
export function buildDispatchBrief({ crop, subtype, today, windowDays, range, before, focus, after, question }) {
  const name = [crop, subtype].filter(Boolean).join(" — ") || "Crop";
  return [
    "Ram Biotech dispatch brief",
    `Crop: ${name}`,
    `Today: ${today || ""}`,
    `Slot size: ${windowDays} days`,
    `SELECTED (staff see only this): ${range.focusFrom} to ${range.focusTo}`,
    `BEFORE (same ${range.padDays} days, context only): ${range.beforeFrom} to ${range.beforeTo}`,
    `AFTER (same ${range.padDays} days, context only): ${range.afterFrom} to ${range.afterTo}`,
    "",
    "Bookings = plants still to hand over, not yet dispatched. Lagwad = plants expected ready.",
    "Gap = lagwad − bookings. Negative gap = over-booked. Overdue = bookings whose delivery date is already past.",
    "SELECTED matches the screen, so past-due bookings can sit in its first slot.",
    "BEFORE and AFTER count only plants dated inside those days.",
    "",
    sectionBlock("BEFORE", { from: range.beforeFrom, to: range.beforeTo }, before),
    "",
    sectionBlock("SELECTED", { from: range.focusFrom, to: range.focusTo }, focus),
    "",
    sectionBlock("AFTER", { from: range.afterFrom, to: range.afterTo }, after),
    "",
    `Question: ${question}`,
  ].join("\n");
}

function changePct(now, prev) {
  const previous = Number(prev) || 0;
  if (previous <= 0) return null;
  return Math.round((((Number(now) || 0) - previous) / previous) * 100);
}

function slotLabel(row) {
  if (!row?.from) return "";
  return row.from === row.to ? row.from : `${row.from} to ${row.to}`;
}

/** Booking insights for the selected range when the model does not answer. */
export function rulesDispatchInsights({ focus, before, after, padDays }) {
  const selected = focus?.totals || {};
  const prior = before?.totals || {};
  const next = after?.totals || {};
  const gap = gapOf(selected);
  const slots = focus?.windows || [];
  const short = [...slots].filter((row) => gapOf(row) < 0).sort((a, b) => gapOf(a) - gapOf(b))[0];
  const open = [...slots].filter((row) => gapOf(row) > 0).sort((a, b) => gapOf(b) - gapOf(a))[0];
  const insights = [];

  if (!selected.dispatch && !selected.lagwad) {
    insights.push({
      title: "No bookings in this range",
      detail: "The selected dates have no dispatch due and no lagwad. Nothing to book against yet.",
      tone: "watch",
    });
  } else if (gap < 0) {
    insights.push({
      title: "Bookings are short of lagwad",
      detail: `${fmt(selected.dispatch)} plants are booked against ${fmt(selected.lagwad)} lagwad. Shortage ${fmt(Math.abs(gap))} (${bookedPct(selected)}% booked).`,
      tone: "risk",
    });
  } else if (gap > 0) {
    insights.push({
      title: "Room left to book",
      detail: `${fmt(selected.dispatch)} booked against ${fmt(selected.lagwad)} lagwad. ${fmt(gap)} plants are still free in the selected dates (${bookedPct(selected)}% booked).`,
      tone: "ok",
    });
  } else {
    insights.push({
      title: "Bookings match lagwad",
      detail: `${fmt(selected.dispatch)} booked and ${fmt(selected.lagwad)} lagwad. This range is even, so new bookings need fresh lagwad.`,
      tone: "watch",
    });
  }

  if (short) {
    insights.push({
      title: "Tightest slot",
      detail: `${slotLabel(short)} is over-booked by ${fmt(Math.abs(gapOf(short)))} plants (${fmt(short.dispatch)} bookings, ${fmt(short.lagwad)} lagwad).`,
      tone: "risk",
    });
  }
  if (open) {
    insights.push({
      title: "Best slot to book",
      detail: `${slotLabel(open)} still has ${fmt(gapOf(open))} free lagwad (${fmt(open.dispatch)} already booked).`,
      tone: "ok",
    });
  }

  const swing = changePct(selected.dispatch, prior.dispatch);
  if (swing != null) {
    const direction = swing > 5 ? "higher" : swing < -5 ? "lower" : "about the same";
    insights.push({
      title: "Bookings vs the days before",
      detail: `Selected bookings are ${direction} than the previous ${padDays} days (${fmt(prior.dispatch)} then, ${fmt(selected.dispatch)} now${swing ? `, ${signed(swing)}%` : ""}).`,
      tone: swing > 5 ? "watch" : "ok",
    });
  }

  if (gapOf(next) < 0 && next.dispatch) {
    insights.push({
      title: "Next period is already tight",
      detail: `The following ${padDays} days already have ${fmt(next.dispatch)} bookings against ${fmt(next.lagwad)} lagwad. Slow new bookings so that period does not get worse.`,
      tone: "watch",
    });
  }

  if (selected.overdueDispatch > 0) {
    insights.push({
      title: "Past-due bookings",
      detail: `${fmt(selected.overdueDispatch)} of the selected dispatch is already past its delivery date. Clear that before promising more.`,
      tone: "risk",
    });
  }

  const headline = insights[0]?.title || "Booking read";
  return { headline, insights: insights.slice(0, MAX_INSIGHTS) };
}

export function parseDispatchInsights(text) {
  const raw = String(text || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const insights = (Array.isArray(parsed.insights) ? parsed.insights : [])
    .map((row) => {
      if (typeof row === "string") return { title: "Booking", detail: row.trim(), tone: "watch" };
      const title = String(row?.title || "").trim().slice(0, 80);
      const detail = String(row?.detail || "").trim().slice(0, 400);
      const tone = TONES.has(row?.tone) ? row.tone : "watch";
      return title && detail ? { title, detail, tone } : null;
    })
    .filter(Boolean)
    .slice(0, MAX_INSIGHTS);
  if (!insights.length) return null;
  const headline = String(parsed.headline || "").trim().slice(0, 160) || insights[0].title;
  return { headline, insights };
}
