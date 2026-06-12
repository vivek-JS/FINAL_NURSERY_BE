import moment from "moment";
import { parseCeoReportQuery } from "../utility/ceoQueryParams.js";
import { resolvePreviousRange } from "../utility/ceoPreviousRange.js";
import { monthBoundsFromYm } from "../utility/istMonthStats.js";
import { fetchSlotAnalysisCore } from "../utility/ceoSlotAnalysisPipeline.js";
import { buildSlotDeltas, generateSlotInsights } from "../utility/ceoSlotInsights.js";

export async function fetchCeoSlotAnalysis(query = {}) {
  const opts = parseCeoReportQuery(query);
  if (opts.error) return { error: opts.error, statusCode: opts.statusCode || 400 };

  const {
    startYmd,
    endYmd,
    rangeStart,
    rangeEnd,
    depth,
    year: queryYear,
  } = opts;

  const plantId = query.plantId ? String(query.plantId) : null;
  const subtypeId = query.subtypeId ? String(query.subtypeId) : null;
  const includePastDue = String(query.includePastDue ?? "true") !== "false";
  const comparePrevious = String(query.comparePrevious ?? "true") !== "false" && depth !== "full";
  const year = queryYear || Number(startYmd.slice(0, 4)) || new Date().getFullYear();
  const withGeo = depth !== "summary";

  const load = (rs, re, geo = withGeo) =>
    fetchSlotAnalysisCore({
      rangeStart: rs,
      rangeEnd: re,
      year,
      plantId,
      subtypeId,
      includePastDue,
      withGeo: geo,
    });

  const [current, previousCtx] = await Promise.all([
    load(rangeStart, rangeEnd),
    comparePrevious
      ? (async () => {
          const prev = resolvePreviousRange(startYmd, endYmd);
          if (!prev) return null;
          const metrics = await load(prev.rangeStart, prev.rangeEnd, false);
          return { ...prev, ...metrics };
        })()
      : Promise.resolve(null),
  ]);

  const currentLabel =
    monthBoundsFromYm(startYmd.slice(0, 7))?.label ||
    moment(startYmd).format("D MMM") + " – " + moment(endYmd).format("D MMM YYYY");

  const payload = {
    tab: "slot-analysis",
    timezone: "Asia/Kolkata",
    depth,
    year,
    filters: { plantId, subtypeId, includePastDue },
    range: { startDate: startYmd, endDate: endYmd, label: currentLabel },
    summary: current.summary,
    plantPicker: current.plantPicker,
    geoTop: current.geoTop,
    deliveryChanges: current.deliveryChanges,
  };

  if (previousCtx) {
    payload.previousRange = {
      startDate: previousCtx.startYmd,
      endDate: previousCtx.endYmd,
      label: previousCtx.label,
    };
    payload.previousSummary = previousCtx.summary;
    payload.deltas = buildSlotDeltas(current.summary, previousCtx.summary);
  }

  payload.insights = generateSlotInsights({
    summary: current.summary,
    plants: current.plants,
    geoTop: current.geoTop,
    dailyLoad: current.dailyLoad,
    previousSummary: previousCtx?.summary,
    currentRange: payload.range,
    previousRange: payload.previousRange,
  });

  if (depth === "summary") {
    return { data: payload };
  }

  payload.dailyLoad = current.dailyLoad;
  payload.weeklyLoad = current.weeklyLoad;
  payload.slotLoad = current.slotLoad;
  payload.statusBreakdown = current.statusBreakdown;

  if (depth !== "summary") {
    payload.periods = current.plants.map((p) => ({
      key: p.plantId,
      label: p.plantName,
      ...p.totals,
      utilizationPct: p.totals.utilizationPct,
    }));
  }

  if (depth === "full") {
    payload.plants = current.plants;
    payload.activeSlots = current.activeSlots;
  }

  return { data: payload };
}
