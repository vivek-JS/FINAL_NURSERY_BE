import moment from "moment";
import { isSowingGapPipelineOrder } from "./slotDispatchStats.js";
import { IST_OFFSET, slotDayEndMoment, slotDayStartMoment } from "./istSlotDate.js";

export function capacityStatus({ gap = 0, excess = 0 } = {}) {
  if (Number(gap) > 0) return "needs_sowing";
  if (Number(excess) > 0) return "saleable_excess";
  return "fulfilled";
}

export function capacityStatusLabel(status) {
  if (status === "needs_sowing") return "Needs sowing";
  if (status === "saleable_excess") return "Saleable excess";
  return "Fulfilled";
}

function orderPlantQty(order) {
  return (Number(order?.numberOfPlants) || 0) + (Number(order?.additionalPlants) || 0);
}

function seedKey(order) {
  const src = String(order?.sowingPlan?.seedSource || "COMPANY").toUpperCase();
  if (src === "RAISING" || src === "MIXED") return src;
  return "COMPANY";
}

/** Booked plants on pipeline orders, split by company / raising / mixed. */
export function seedSourceTotals(orders) {
  const empty = () => ({ plants: 0, covered: 0, gap: 0 });
  const totals = { COMPANY: empty(), RAISING: empty(), MIXED: empty() };
  for (const order of orders || []) {
    if (!isSowingGapPipelineOrder(order)) continue;
    const bucket = totals[seedKey(order)];
    const qty = orderPlantQty(order);
    bucket.plants += qty;
    if (order?.sowingDone) bucket.covered += qty;
    else bucket.gap += qty;
  }
  return totals;
}

/** Majority seed source on pipeline orders. Empty set stays Company. */
export function majoritySeedPlan(orders) {
  const counts = { COMPANY: 0, RAISING: 0, MIXED: 0 };
  for (const order of orders || []) {
    if (!isSowingGapPipelineOrder(order)) continue;
    const src = String(order?.sowingPlan?.seedSource || "COMPANY").toUpperCase();
    if (counts[src] == null) counts.COMPANY += 1;
    else counts[src] += 1;
  }
  let best = "COMPANY";
  let bestN = 0;
  for (const [key, n] of Object.entries(counts)) {
    if (n > bestN) {
      best = key;
      bestN = n;
    }
  }
  return best;
}

export function canBookPlants(totalPlants, booked, bufferAmount) {
  return Math.max(
    0,
    (Number(totalPlants) || 0) - (Number(booked) || 0) - (Number(bufferAmount) || 0)
  );
}

/** Plants still free to book: sowed excess minus the sowing gap. Negative means more sowing is needed. */
export function canBookFromExcess(excess, gap = 0) {
  return (Number(excess) || 0) - (Number(gap) || 0);
}

export function parseRangeBound(value, fallback) {
  if (!value) return fallback.clone();
  const raw = String(value).trim();
  const iso = moment(raw, "YYYY-MM-DD", true);
  if (iso.isValid()) return iso.utcOffset(IST_OFFSET, true).startOf("day");
  const dmy = moment(raw, "DD-MM-YYYY", true);
  if (dmy.isValid()) return dmy.utcOffset(IST_OFFSET, true).startOf("day");
  return fallback.clone();
}

/** Slot window overlaps [from, to] on IST calendar days. */
export function slotOverlapsRange(startDay, endDay, from, to) {
  const start = slotDayStartMoment(startDay);
  const end = slotDayEndMoment(endDay);
  if (!start || !end || !from || !to) return false;
  return end.isSameOrAfter(from, "day") && start.isSameOrBefore(to, "day");
}

export function defaultCapacityRange(now = moment().utcOffset(IST_OFFSET)) {
  const from = now.clone().startOf("day");
  const to = from.clone().add(13, "days").endOf("day");
  return { from, to };
}

/** PlantSlot.year values that can hold a slot overlapping [from, to]. */
export function capacityYearsForRange(from, to) {
  const years = new Set();
  for (let year = from.year(); year <= to.year(); year += 1) years.add(year);
  if (from.month() === 0) years.add(from.year() - 1);
  if (to.month() === 11) years.add(to.year() + 1);
  return [...years].sort((a, b) => a - b);
}

/** YYYYMMDD integer for a DD-MM-YYYY slot day. Invalid dates return null. */
export function slotDaySortKey(ddmmyyyy) {
  const m = moment(ddmmyyyy, "DD-MM-YYYY", true);
  if (!m.isValid()) return null;
  return m.year() * 10000 + (m.month() + 1) * 100 + m.date();
}
