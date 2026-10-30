import moment from "moment";
import { IST_OFFSET } from "../utility/istSlotDate.js";
import { OVERDUE_LOOKBACK_DAYS } from "../utility/capacityBoardMetrics.js";
import { bucketWindows, fillDispatch, fillLagwad, istDay, summarize } from "../utility/dispatchLagwadBuckets.js";
import { loadDueOrders, loadOpenLagwadLines, loadSlotIdSet, resolveCropContext } from "./dispatchLagwadSources.js";

/**
 * Dispatch due (undispatched, unloaded pipeline orders by deliveryDate) vs lagwad
 * (unsold secondary-inward entries by expected ready date) in fixed day windows.
 * When the range starts on/before today, past-due orders (last OVERDUE_LOOKBACK_DAYS)
 * and already-ready lagwad roll into the first window.
 * Pass rollPast false to keep every plant on its own date (used for the days
 * before and after the range the desk is looking at).
 */
export async function getDispatchLagwad({ plantId, subtypeId, from, to, windowDays, rollPast }) {
  const today = moment().utcOffset(IST_OFFSET).format("YYYY-MM-DD");
  const windows = bucketWindows(from, to, windowDays);
  const roll = typeof rollPast === "boolean" ? rollPast : from <= today;
  const start = istDay(from);
  const end = istDay(to).endOf("day");
  const orderStart = roll
    ? moment.min(start.clone(), istDay(today).subtract(OVERDUE_LOOKBACK_DAYS, "days"))
    : start.clone();

  const [context, slotIds, orders, allLines] = await Promise.all([
    resolveCropContext(plantId, subtypeId),
    loadSlotIdSet(plantId, subtypeId, start.year(), end.year()),
    loadDueOrders({
      plantId,
      subtypeId,
      rangeStart: orderStart.utc().toDate(),
      rangeEnd: end.clone().utc().toDate(),
    }),
    loadOpenLagwadLines(),
  ]);

  fillDispatch(windows, orders, { rollPast: roll, today });
  fillLagwad(windows, allLines.filter((line) => slotIds.has(line.slotId)), { rollPast: roll, today });
  const { months, totals } = summarize(windows);

  return {
    context: { ...context, from, to, windowDays, today, overdueLookbackDays: OVERDUE_LOOKBACK_DAYS },
    windows,
    months,
    totals,
  };
}
