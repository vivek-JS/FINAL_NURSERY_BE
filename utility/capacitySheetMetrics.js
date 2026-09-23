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
