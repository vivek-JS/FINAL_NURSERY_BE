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
import { parseCeoReportQuery } from "../utility/ceoQueryParams.js";
import { generateIstMonthKeys } from "../utility/istMonthStats.js";
import moment from "moment";

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

  const [misResult, dueSummary, deliveryChanges, geoTop, futureRow] =
    await Promise.all([
      depth === "summary"
        ? Promise.resolve(null)
        : fetchAdminDailyMis(startYmd, endYmd, {
            dueOnly,
            includeAllPastDue,
          }),
      aggregateDueSummary(rangeStart, rangeEnd, { dueOnly }),
      aggregateDeliveryChangeSummary(rangeStart, rangeEnd, extraMatch),
      aggregateGeoTop(rangeStart, rangeEnd, extraMatch),
      includeFuture
        ? aggregateFutureDeliveryRows(rangeEnd)
        : Promise.resolve(null),
    ]);

  let misData = misResult?.data;
  if (depth === "summary") {
    const fullMis = await fetchAdminDailyMis(startYmd, endYmd, {
      dueOnly,
      includeAllPastDue: false,
    });
    misData = fullMis?.data;
  }

  const futurePlants = futureRow?.delivery?.total || { orders: 0, plants: 0 };
  const summary = buildSummaryFromMis(misData, dueSummary, futurePlants);
  summary.deliveryChanged = {
    orders: deliveryChanges.totalChanges.orders,
    farmers: deliveryChanges.totalChanges.farmers,
    plants: deliveryChanges.byDirection.early.plants +
      deliveryChanges.byDirection.late.plants +
      deliveryChanges.byDirection.sameWindow.plants,
  };
  summary.earlyDelivery = {
    orders: deliveryChanges.earlyDispatch.orders,
    farmers: deliveryChanges.earlyDispatch.farmers,
    plants: deliveryChanges.earlyDispatch.plants,
  };

  const payload = {
    tab: "order-delivery-flow",
    granularity,
    timezone: "Asia/Kolkata",
    depth,
    range: { startDate: startYmd, endDate: endYmd },
    summary,
    deliveryChanges,
    geoTop,
    dueSummary,
    dueOnly,
    includePastDue,
    includeFuture,
  };

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

  payload.periods = periods;
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
