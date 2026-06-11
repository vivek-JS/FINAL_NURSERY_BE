import { fetchAdminDailyMis } from "../../../services/adminDailyMis.service.js";
import { aggregateDueSummary } from "../../../utility/adminMisDue.js";
import { aggregateFutureDeliveryRows } from "../utility/ceoFutureDelivery.js";
import { aggregateDeliveryChangeSummary } from "../utility/ceoDeliveryChanges.js";
import { aggregateGeoTop } from "../utility/ceoGeoBreakdown.js";
import {
  buildSummaryFromMis,
  compactPeriodRow,
  rollupDaysToMonths,
} from "../utility/ceoMetricDrillHints.js";
import {
  buildOrderDeliveryDeltas,
  generateOrderDeliveryInsights,
} from "../utility/ceoOrderDeliveryInsights.js";
import { resolvePreviousRange } from "../utility/ceoPreviousRange.js";
import { parseCeoReportQuery } from "../utility/ceoQueryParams.js";
import { generateIstMonthKeys, monthBoundsFromYm } from "../utility/istMonthStats.js";
import moment from "moment";

async function fetchCoreMetrics(startYmd, endYmd, rangeStart, rangeEnd, { dueOnly, includeAllPastDue, extraMatch, includeFuture }) {
  const [misResult, dueSummary, deliveryChanges, geoTop, futureRow] = await Promise.all([
    fetchAdminDailyMis(startYmd, endYmd, { dueOnly, includeAllPastDue }),
    aggregateDueSummary(rangeStart, rangeEnd, { dueOnly }),
    aggregateDeliveryChangeSummary(rangeStart, rangeEnd, extraMatch),
    aggregateGeoTop(rangeStart, rangeEnd, extraMatch),
    includeFuture ? aggregateFutureDeliveryRows(rangeEnd) : Promise.resolve(null),
  ]);

  const misData = misResult?.data;
  const futurePlants = futureRow?.delivery?.total || { orders: 0, plants: 0 };
  const summary = buildSummaryFromMis(misData, dueSummary, futurePlants);
  summary.deliveryChanged = {
    orders: deliveryChanges.totalChanges.orders,
    farmers: deliveryChanges.totalChanges.farmers,
    plants:
      deliveryChanges.byDirection.early.plants +
      deliveryChanges.byDirection.late.plants +
      deliveryChanges.byDirection.sameWindow.plants,
  };
  summary.earlyDelivery = {
    orders: deliveryChanges.earlyDispatch.orders,
    farmers: deliveryChanges.earlyDispatch.farmers,
    plants: deliveryChanges.earlyDispatch.plants,
  };

  return { misData, summary, deliveryChanges, geoTop, futureRow, dueSummary };
}

function attachPeriodMom(periods) {
  const real = periods.filter((p) => !p.isSynthetic && /^\d{4}-\d{2}$/.test(p.key));
  const prevMap = new Map();
  for (let i = 1; i < real.length; i++) {
    prevMap.set(real[i].key, real[i - 1]);
  }
  return periods.map((p) => {
    if (p.isSynthetic || !/^\d{4}-\d{2}$/.test(p.key)) return p;
    const prev = prevMap.get(p.key);
    if (!prev) return p;
    const curPlants = p.booking?.plants ?? 0;
    const prevPlants = prev.booking?.plants ?? 0;
    const changePct = prevPlants > 0 ? Math.round(((curPlants - prevPlants) / prevPlants) * 1000) / 10 : curPlants > 0 ? 100 : 0;
    return {
      ...p,
      mom: {
        bookingPlants: changePct,
        previousKey: prev.key,
        previousLabel: prev.label,
      },
    };
  });
}

export async function fetchCeoOrderDeliveryFlow(query = {}) {
  const opts = parseCeoReportQuery(query);
  if (opts.error) return { error: opts.error, statusCode: opts.statusCode || 400 };

  const {
    startYmd,
    endYmd,
    rangeStart,
    rangeEnd,
    depth,
    granularity,
    includePastDue,
    includeFuture,
    dueOnly,
    includeAllPastDue,
    extraMatch,
  } = opts;

  const comparePrevious = String(query.comparePrevious ?? "true") !== "false";

  const [current, previousCtx] = await Promise.all([
    fetchCoreMetrics(startYmd, endYmd, rangeStart, rangeEnd, {
      dueOnly,
      includeAllPastDue: depth === "summary" ? false : includeAllPastDue,
      extraMatch,
      includeFuture,
    }),
    comparePrevious
      ? (async () => {
          const prev = resolvePreviousRange(startYmd, endYmd);
          if (!prev) return null;
          const metrics = await fetchCoreMetrics(prev.startYmd, prev.endYmd, prev.rangeStart, prev.rangeEnd, {
            dueOnly,
            includeAllPastDue: false,
            extraMatch,
            includeFuture: false,
          });
          return { ...prev, ...metrics };
        })()
      : Promise.resolve(null),
  ]);

  const { misData, summary, deliveryChanges, geoTop, futureRow } = current;
  const currentLabel =
    monthBoundsFromYm(startYmd.slice(0, 7))?.label ||
    moment(startYmd).format("D MMM") + " – " + moment(endYmd).format("D MMM YYYY");

  const payload = {
    tab: "order-delivery-flow",
    granularity,
    timezone: "Asia/Kolkata",
    depth,
    range: { startDate: startYmd, endDate: endYmd, label: currentLabel },
    summary,
    deliveryChanges,
    geoTop,
    dueOnly,
    includePastDue,
    includeFuture,
  };

  if (previousCtx) {
    payload.previousRange = {
      startDate: previousCtx.startYmd,
      endDate: previousCtx.endYmd,
      label: previousCtx.label,
    };
    payload.previousSummary = previousCtx.summary;
    payload.deltas = buildOrderDeliveryDeltas(summary, previousCtx.summary);
    payload.insights = generateOrderDeliveryInsights({
      summary,
      previousSummary: previousCtx.summary,
      deltas: payload.deltas,
      deliveryChanges,
      previousDeliveryChanges: previousCtx.deliveryChanges,
      geoTop,
      previousGeoTop: previousCtx.geoTop,
      currentRange: payload.range,
      previousRange: payload.previousRange,
    });
  }

  if (depth === "summary") {
    payload.syntheticRows = {
      pastDue: includePastDue ? { key: "past-due", label: "Past due (before range)" } : null,
      future: includeFuture ? { key: "future", label: "Future delivery (after range)" } : null,
    };
    return { data: payload };
  }

  let days = misData?.days || [];
  if (granularity === "month") {
    days = rollupDaysToMonths(days.filter((d) => !d.isPastDue));
    days = days.map((d) => ({
      ...d,
      date: d.key,
      label: moment(d.key, "YYYY-MM").format("MMM YYYY"),
    }));
  } else {
    days = days.map((d) => ({
      ...d,
      label:
        d.label ||
        (d.date === "past-due"
          ? "Past due (before range)"
          : moment(d.date, "YYYY-MM-DD").format("D MMM YYYY")),
    }));
  }

  const periods = [];
  for (const day of days) {
    if (day.isPastDue && !includePastDue) continue;
    periods.push(compactPeriodRow(day, depth));
  }

  if (includeFuture && futureRow) {
    periods.push(
      compactPeriodRow(
        {
          date: "future",
          label: futureRow.label,
          isFuture: true,
          booking: futureRow.booking,
          delivery: futureRow.delivery,
        },
        depth
      )
    );
  }

  payload.periods =
    granularity === "month" ? attachPeriodMom(periods) : periods;
  payload.monthKeys =
    granularity === "month" ? generateIstMonthKeys(startYmd, endYmd) : undefined;

  if (depth !== "full") {
    payload.periods = payload.periods.map((p) => {
      const { delivery, ...rest } = p;
      return rest;
    });
  }

  return { data: payload };
}
