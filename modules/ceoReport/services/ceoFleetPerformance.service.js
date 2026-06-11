import moment from "moment";
import { parseCeoReportQuery } from "../utility/ceoQueryParams.js";
import { resolvePreviousRange } from "../utility/ceoPreviousRange.js";
import { monthBoundsFromYm } from "../utility/istMonthStats.js";
import {
  aggregateFleetSummary,
  aggregateFleetPeriods,
  aggregateTopDrivers,
  aggregateTopVehicles,
  fetchVillageDeliveryBundle,
  aggregateStatusMix,
  fetchRecentTrips,
} from "../utility/ceoFleetPipeline.js";
import { buildFleetDeltas, generateFleetInsights } from "../utility/ceoFleetInsights.js";

function periodLabel(key, granularity) {
  if (granularity === "month" && /^\d{4}-\d{2}$/.test(key)) {
    return moment(key, "YYYY-MM").format("MMM YYYY");
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    return moment(key, "YYYY-MM-DD").format("D MMM YYYY");
  }
  return key;
}

async function fetchFleetCore(rangeStart, rangeEnd, { depth, granularity }) {
  const [summary, periods, topDrivers, topVehicles, villageBundle, statusMix, trips] =
    await Promise.all([
      aggregateFleetSummary(rangeStart, rangeEnd),
      depth !== "summary" ? aggregateFleetPeriods(rangeStart, rangeEnd, granularity) : [],
      aggregateTopDrivers(rangeStart, rangeEnd),
      aggregateTopVehicles(rangeStart, rangeEnd),
      fetchVillageDeliveryBundle(rangeStart, rangeEnd),
      aggregateStatusMix(rangeStart, rangeEnd),
      depth === "full" ? fetchRecentTrips(rangeStart, rangeEnd) : [],
    ]);

  const { topVillages, villagesServed } = villageBundle;

  return {
    summary: {
      ...summary,
      villagesServed,
      deliveryRate:
        summary.trips > 0
          ? Math.round((summary.delivered / summary.trips) * 1000) / 10
          : 0,
      inPipeline: summary.inTransit + summary.loaded + summary.pending,
    },
    periods,
    topDrivers,
    topVehicles,
    topVillages,
    statusMix,
    trips,
  };
}

export async function fetchCeoFleetPerformance(query = {}) {
  const opts = parseCeoReportQuery(query);
  if (opts.error) return { error: opts.error, statusCode: opts.statusCode || 400 };

  const { startYmd, endYmd, rangeStart, rangeEnd, depth, granularity } = opts;
  const comparePrevious = String(query.comparePrevious ?? "true") !== "false";

  const [current, previousCtx] = await Promise.all([
    fetchFleetCore(rangeStart, rangeEnd, { depth, granularity }),
    comparePrevious
      ? (async () => {
          const prev = resolvePreviousRange(startYmd, endYmd);
          if (!prev) return null;
          const metrics = await fetchFleetCore(prev.rangeStart, prev.rangeEnd, {
            depth: "summary",
            granularity,
          });
          return { ...prev, ...metrics };
        })()
      : Promise.resolve(null),
  ]);

  const currentLabel =
    monthBoundsFromYm(startYmd.slice(0, 7))?.label ||
    moment(startYmd).format("D MMM") + " – " + moment(endYmd).format("D MMM YYYY");

  const payload = {
    tab: "fleet-performance",
    granularity,
    timezone: "Asia/Kolkata",
    depth,
    range: { startDate: startYmd, endDate: endYmd, label: currentLabel },
    summary: current.summary,
    topDrivers: current.topDrivers,
    topVehicles: current.topVehicles,
    topVillages: current.topVillages,
    statusMix: current.statusMix,
  };

  if (previousCtx) {
    payload.previousRange = {
      startDate: previousCtx.startYmd,
      endDate: previousCtx.endYmd,
      label: previousCtx.label,
    };
    payload.previousSummary = previousCtx.summary;
    payload.deltas = buildFleetDeltas(current.summary, previousCtx.summary);
    payload.insights = generateFleetInsights({
      summary: current.summary,
      previousSummary: previousCtx.summary,
      deltas: payload.deltas,
      topDrivers: current.topDrivers,
      topVehicles: current.topVehicles,
      topVillages: current.topVillages,
      currentRange: payload.range,
      previousRange: payload.previousRange,
    });
  }

  if (depth === "summary") {
    return { data: payload };
  }

  payload.periods = (current.periods || []).map((p) => ({
    ...p,
    label: periodLabel(p.key, granularity),
  }));

  if (depth === "full") {
    payload.trips = current.trips;
  }

  return { data: payload };
}
