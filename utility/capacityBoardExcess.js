import { dmyToYmd } from "../services/sowBatchStock.service.js";
import { isWatermelonPlantName } from "../services/sowBatchIrrelevant.service.js";

/** Watermelon leftover older than this many days past ready is off the capacity board. */
export const WATERMELON_BOARD_PAST_READY_DAYS = 4;

function ymdMinusDays(ymd, days) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() - Math.max(0, Number(days) || 0));
  return dt.toISOString().slice(0, 10);
}

/**
 * Capacity board free plants: never count irrelevant batches.
 * Watermelon: only batches ready on/after today − 4 (older leftover is stale).
 */
export function batchCountsOnCapacityBoard(batch, { todayYmd, plantName } = {}) {
  if (!batch || batch.isIrrelevant) return false;
  if (!isWatermelonPlantName(plantName)) return true;
  const readyYmd = dmyToYmd(batch.plantReadyDate);
  if (!readyYmd || !todayYmd) return false;
  const cutoff = ymdMinusDays(todayYmd, WATERMELON_BOARD_PAST_READY_DAYS);
  return Boolean(cutoff) && readyYmd >= cutoff;
}

export function capacityBoardIncludeBatch({ todayYmd, plantName } = {}) {
  return (batch) => batchCountsOnCapacityBoard(batch, { todayYmd, plantName });
}
