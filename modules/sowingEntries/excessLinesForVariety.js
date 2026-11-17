import SowingEntry from "../../models/sowingEntry.model.js";
import { OVERDUE_LOOKBACK_DAYS } from "../../utility/capacityBoardMetrics.js";
import { excessFieldsForBatch } from "../../utility/sowingBatchExcessStamp.js";
import { sowDayFrom } from "./mapSowingEntry.js";

function ymdMinusDays(ymd, days) {
  const match = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() - Math.max(0, Number(days) || 0));
  return date.toISOString().slice(0, 10);
}

/** Same window as the capacity board: drop ready dates older than the lookback. */
export function entryCountsOnBoard(plantReadyDate, todayYmd) {
  const ready = sowDayFrom(plantReadyDate);
  if (!ready || !todayYmd) return true;
  const cutoff = ymdMinusDays(todayYmd, OVERDUE_LOOKBACK_DAYS);
  return !cutoff || ready >= cutoff;
}

/** One sowing entry in the shape the excess-age sheet already reads. */
export function excessLineFromEntry(doc) {
  if (!doc || doc.isIrrelevant) return null;
  const excess = excessFieldsForBatch(doc, doc.sowingBufferPct || 0).shownExcess;
  if (excess < 1) return null;
  return {
    batchId: String(doc._id || doc.sourceBatchId || ""),
    requestNumber: doc.requestNumber || "",
    sowingDate: doc.sowDay || sowDayFrom(doc.sowingDate),
    plantReadyDate: doc.plantReadyDate || "",
    plantsSowed: Math.max(0, Math.floor(Number(doc.plantsSowed) || 0)),
    excessPlants: excess,
    isIrrelevant: false,
    shedName: "",
  };
}

/** Bookable sowing entries for this variety. Ready today-or-earlier is the Now card. */
export async function excessLinesForVariety(plantId, subtypeId, todayYmd) {
  if (!plantId || !subtypeId) return [];
  const docs = await SowingEntry.find({
    plantId,
    subtypeId,
    isIrrelevant: { $ne: true },
  }).lean();
  const lines = [];
  for (const doc of docs) {
    if (!entryCountsOnBoard(doc.plantReadyDate, todayYmd)) continue;
    const line = excessLineFromEntry(doc);
    if (line) lines.push(line);
  }
  lines.sort((a, b) => sowDayFrom(a.plantReadyDate).localeCompare(sowDayFrom(b.plantReadyDate)));
  return lines;
}
