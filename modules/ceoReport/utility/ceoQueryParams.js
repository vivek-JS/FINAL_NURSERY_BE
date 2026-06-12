import mongoose from "mongoose";
import { parseCentralReportDateRange } from "../../../utility/centralReportEngine/dateRange.js";
import { parseMisDueFlags } from "../../../utility/adminMisDue.js";
import { monthBoundsFromYm } from "./istMonthStats.js";
import { istDayBoundsFromYmd } from "../../../utility/istOrderDateStats.js";

function toOid(id) {
  if (!id) return null;
  const s = String(id).trim();
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : s;
}

export function parseCeoReportQuery(query = {}) {
  const { startDate, endDate } = query;
  const parsed = parseCentralReportDateRange(startDate, endDate);
  if (parsed.error) return { error: parsed.error, statusCode: 400 };

  const depth = String(query.depth || "summary").toLowerCase();
  const validDepth = ["summary", "periods", "full"].includes(depth) ? depth : "summary";

  const granularity = String(query.granularity || "day").toLowerCase() === "month" ? "month" : "day";

  const dueFlags = parseMisDueFlags(query);
  const includePastDue = String(query.includePastDue ?? "true") !== "false";
  const includeFuture = String(query.includeFuture ?? "true") !== "false";

  const extraMatch = {};
  if (query.plantId) extraMatch.plantName = toOid(query.plantId);
  if (query.subtypeId) extraMatch.plantSubtype = toOid(query.subtypeId);
  if (query.nurserySite) {
    extraMatch.expectedNursery = String(query.nurserySite).trim().toUpperCase();
  }

  return {
    ...parsed,
    depth: validDepth,
    granularity,
    includePastDue,
    includeFuture,
    dueOnly: dueFlags.dueOnly,
    includeAllPastDue: dueFlags.includeAllPastDue || includePastDue,
    extraMatch,
    plantId: query.plantId,
    year: query.year ? Number(query.year) : new Date().getFullYear(),
  };
}

/** Resolve period key to IST date window for breakdown/drill. */
export function resolvePeriodWindow(query, baseWindow) {
  const periodKey = String(query.periodKey || query.date || "").trim();
  if (!periodKey) return baseWindow;

  if (periodKey === "past-due") {
    return {
      ...baseWindow,
      periodKey,
      rangeStart: new Date(0),
      rangeEnd: baseWindow.rangeStart,
    };
  }
  if (periodKey === "future") {
    return {
      ...baseWindow,
      periodKey,
      rangeStart: baseWindow.rangeEnd,
      rangeEnd: new Date("2099-12-31T23:59:59.999+05:30"),
    };
  }

  if (/^\d{4}-\d{2}$/.test(periodKey)) {
    const bounds = monthBoundsFromYm(periodKey);
    if (!bounds) return { error: "Invalid month periodKey" };
    return {
      startYmd: bounds.startYmd,
      endYmd: bounds.endYmd,
      rangeStart: bounds.rangeStart,
      rangeEnd: bounds.rangeEnd,
      periodKey,
    };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(periodKey)) {
    const { start, end } = istDayBoundsFromYmd(periodKey);
    return {
      startYmd: periodKey,
      endYmd: periodKey,
      rangeStart: start,
      rangeEnd: end,
      periodKey,
    };
  }

  return baseWindow;
}
