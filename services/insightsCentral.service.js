/**
 * Central report engine → agri-insights-hub operations payload.
 * Uses the same rules as Admin MIS (admin-daily-mis).
 */
import Dispatch from "../models/dispatch.model.js";
import { fetchAdminDailyMis } from "./adminDailyMis.service.js";
import { getCentralReportEngineMeta } from "../utility/centralReportEngine/index.js";

/** DD-MM-YYYY → YYYY-MM-DD for central report date parser. */
export function insightsQueryDateToYmd(ddMmYyyy) {
  const parts = String(ddMmYyyy || "").trim().split("-");
  if (parts.length !== 3) return null;
  const [dd, mm, yyyy] = parts;
  if (!dd || !mm || !yyyy) return null;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function metricPair(m) {
  return {
    orders: Number(m?.orders) || 0,
    plants: Number(m?.plants) || 0,
  };
}

function shapeDailySeries(days = []) {
  return days.map((d) => ({
    date: d.date,
    booking: metricPair(d.booking),
    uniqueOrders: Number(d.uniqueOrders) || 0,
    delivery: {
      accepted: metricPair(d.delivery?.accepted),
      dispatched: metricPair(d.delivery?.dispatched),
      completed: metricPair(d.delivery?.completed),
      dispatchProcess: metricPair(d.delivery?.dispatchProcess),
      partiallyCompleted: {
        orders: Number(d.delivery?.partiallyCompleted?.orders) || 0,
        plants: Number(d.delivery?.partiallyCompleted?.plants) || 0,
        plantsRemaining: Number(d.delivery?.partiallyCompleted?.plantsRemaining) || 0,
      },
      total: metricPair(d.delivery?.total),
    },
  }));
}

function shapeVarietyRow(row) {
  const booked = Number(row.booking?.plants) || 0;
  const out =
    (Number(row.delivery?.dispatched?.plants) || 0) +
    (Number(row.delivery?.completed?.plants) || 0) +
    (Number(row.delivery?.dispatchProcess?.plants) || 0);
  return {
    plantName: row.plantName || "Unknown",
    subtype: row.subtype || "Other",
    booking: metricPair(row.booking),
    delivery: {
      accepted: metricPair(row.delivery?.accepted),
      farmReady: metricPair(row.delivery?.farmReady),
      readyForDispatch: metricPair(row.delivery?.readyForDispatch),
      dispatched: metricPair(row.delivery?.dispatched),
      completed: metricPair(row.delivery?.completed),
      dispatchProcess: metricPair(row.delivery?.dispatchProcess),
      partiallyCompleted: row.delivery?.partiallyCompleted || {
        orders: 0,
        plants: 0,
        plantsRemaining: 0,
      },
      other: metricPair(row.delivery?.other),
      total: metricPair(row.delivery?.total),
    },
    dispatchProgressPct: booked > 0 ? Math.min(100, Math.round((out / booked) * 100)) : 0,
  };
}

async function fetchDispatchTripsByDay(rangeStart, rangeEnd) {
  const rows = await Dispatch.aggregate([
    {
      $match: {
        isDeleted: false,
        transportStatus: { $ne: "CANCELLED" },
        createdAt: { $gte: rangeStart, $lte: rangeEnd },
      },
    },
    {
      $project: {
        day: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$createdAt",
            timezone: "Asia/Kolkata",
          },
        },
        plantQty: {
          $sum: {
            $map: {
              input: { $ifNull: ["$plantsDetails", []] },
              as: "p",
              in: {
                $ifNull: ["$$p.totalPlants", { $ifNull: ["$$p.quantity", 0] }],
              },
            },
          },
        },
      },
    },
    {
      $group: {
        _id: "$day",
        trips: { $sum: 1 },
        plants: { $sum: "$plantQty" },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return rows.map((r) => ({
    date: r._id,
    trips: r.trips || 0,
    plants: r.plants || 0,
  }));
}

/**
 * @param {string} startDate DD-MM-YYYY
 * @param {string} endDate DD-MM-YYYY
 * @param {{ dueOnly?: boolean, includeAllPastDue?: boolean }} [options]
 */
export async function fetchInsightsOperations(startDate, endDate, options = {}) {
  const startYmd = insightsQueryDateToYmd(startDate);
  const endYmd = insightsQueryDateToYmd(endDate);
  if (!startYmd || !endYmd) {
    return { error: "Invalid startDate or endDate (use DD-MM-YYYY)", statusCode: 400 };
  }

  const misResult = await fetchAdminDailyMis(startYmd, endYmd, {
    dueOnly: Boolean(options.dueOnly),
    includeAllPastDue: Boolean(options.includeAllPastDue),
  });
  if (misResult.error) {
    return { error: misResult.error, statusCode: misResult.statusCode || 400 };
  }

  const data = misResult.data || {};
  const rangeStart = new Date(`${startYmd}T00:00:00+05:30`);
  const rangeEnd = new Date(`${endYmd}T23:59:59.999+05:30`);
  const dispatchTripsByDay = await fetchDispatchTripsByDay(rangeStart, rangeEnd);
  const dispatchTripMap = new Map(dispatchTripsByDay.map((d) => [d.date, d]));

  const dailySeries = shapeDailySeries(data.days).map((d) => ({
    ...d,
    dispatchTrips: dispatchTripMap.get(d.date) || { trips: 0, plants: 0 },
  }));

  const meta = getCentralReportEngineMeta();

  return {
    data: {
      source: "central-report-engine",
      reportId: "admin-daily-mis",
      timezone: data.timezone || "Asia/Kolkata",
      startDate: data.startDate || startYmd,
      endDate: data.endDate || endYmd,
      totals: {
        booking: metricPair(data.totals?.booking),
        delivery: data.totals?.delivery
          ? {
              accepted: metricPair(data.totals.delivery.accepted),
              farmReady: metricPair(data.totals.delivery.farmReady),
              readyForDispatch: metricPair(data.totals.delivery.readyForDispatch),
              dispatched: metricPair(data.totals.delivery.dispatched),
              completed: metricPair(data.totals.delivery.completed),
              dispatchProcess: metricPair(data.totals.delivery.dispatchProcess),
              partiallyCompleted: data.totals.delivery.partiallyCompleted,
              other: metricPair(data.totals.delivery.other),
              total: metricPair(data.totals.delivery.total),
            }
          : null,
        uniqueOrders: Number(data.totals?.uniqueOrders) || 0,
      },
      dailySeries,
      dispatchTripsByDay,
      varietyTable: (data.varietyTable || []).map(shapeVarietyRow),
      varietyTotals: data.varietyTotals
        ? shapeVarietyRow({ plantName: "Total", subtype: "—", ...data.varietyTotals })
        : null,
      dueSummary: data.dueSummary || null,
      engine: {
        timezone: meta.timezone,
        reports: meta.reports?.filter((r) =>
          ["admin-daily-mis", "admin-mis-sales", "admin-mis-dealer"].includes(r.id)
        ),
      },
    },
  };
}
