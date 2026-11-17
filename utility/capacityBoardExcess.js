import { dmyToYmd } from "../services/sowBatchStock.service.js";
import { OVERDUE_LOOKBACK_DAYS } from "./capacityBoardMetrics.js";
import { excessFieldsForBatch } from "./sowingBatchExcessStamp.js";

function ymdMinusDays(ymd, days) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() - Math.max(0, Number(days) || 0));
  return dt.toISOString().slice(0, 10);
}

function ymdToDmy(ymd) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Capacity board free plants:
 * - never count irrelevant sowing batches
 * - never count old sowing entries (ready before today − lookback)
 */
export function batchCountsOnCapacityBoard(batch, { todayYmd } = {}) {
  if (!batch || batch.isIrrelevant) return false;
  const lookback = OVERDUE_LOOKBACK_DAYS;
  if (lookback == null || !todayYmd) return true;
  const ready = dmyToYmd(batch.plantReadyDate);
  if (!ready) return true;
  const cutoff = ymdMinusDays(todayYmd, lookback);
  return !cutoff || ready >= cutoff;
}

export function capacityBoardIncludeBatch(opts = {}) {
  return (batch) => batchCountsOnCapacityBoard(batch, opts);
}

/**
 * Plants still free to sell on one sowing.
 * Irrelevant sowings are 0. Destroyed plants are already gone.
 * Confirmed counts (noMortalityReserve) keep sowed − orders.
 * Every other sowing keeps the mortality percent back: sowed − mortality − orders.
 */
export function batchBookableExcess(batch, sowingBufferPct = 0) {
  if (!batch || batch.isIrrelevant) return 0;
  const destroyed = Math.max(0, Math.floor(Number(batch.destroyedPlants) || 0));
  const sowed = Math.max(0, Math.floor(Number(batch.plantsSowed) || 0) - destroyed);
  const batchPct = Number(batch.sowingBufferPct);
  const pct = Number.isFinite(batchPct) ? batchPct : sowingBufferPct;
  return excessFieldsForBatch({ ...batch, plantsSowed: sowed, sowingBufferPct: pct }, pct).shownExcess;
}

/**
 * Date-wise free: ready today-or-earlier stays on the sowing slot;
 * not-yet-ready free is keyed by plantReadyDate (e.g. Prachand → 15 Nov, not Now).
 */
export function splitBoardExcessByReady(batches, sowingBufferPct = 0, includeBatch = null, todayYmd = "") {
  let onSlot = 0;
  const byFutureReady = new Map();
  for (const batch of batches || []) {
    if (typeof includeBatch === "function" ? !includeBatch(batch) : batch?.isIrrelevant) continue;
    const free = batchBookableExcess(batch, sowingBufferPct);
    if (free < 1) continue;
    const ready = dmyToYmd(batch.plantReadyDate);
    if (!ready || !todayYmd || ready <= todayYmd) {
      onSlot += free;
      continue;
    }
    byFutureReady.set(ready, (byFutureReady.get(ready) || 0) + free);
  }
  return { onSlot, byFutureReady };
}

/** Merge future-ready free into one board slot row per ready day. */
export function futureReadyBoardSlots(byReadyYmd, slotIdsByReady) {
  const rows = [];
  for (const [readyYmd, plants] of byReadyYmd || []) {
    const free = Math.max(0, Math.floor(Number(plants) || 0));
    if (free < 1) continue;
    const dmy = ymdToDmy(readyYmd);
    if (!dmy) continue;
    const ids = [...new Set((slotIdsByReady?.get(readyYmd) || []).map(String).filter(Boolean))];
    rows.push({
      slotId: ids[0] || null,
      slotIds: ids,
      startDay: dmy,
      endDay: dmy,
      booked: 0,
      gap: 0,
      excess: free,
      mortality: 0,
      pendingDispatch: 0,
      readyYmd,
    });
  }
  return rows.sort((a, b) => String(a.readyYmd).localeCompare(String(b.readyYmd)));
}

export { ymdToDmy };
