import moment from "moment";
import Order from "../models/order.model.js";
import { LINE_PLANT_TOTAL_ADD_FIELDS, getIstTodayYmd, istDateStringExpr } from "../utility/istOrderDateStats.js";
import { parseCentralReportDateRange } from "../utility/centralReportEngine/dateRange.js";
import { matchDeliveryDateInRange } from "../utility/centralReportEngine/deliveryMatch.js";
import { PLANT_SUBTYPE_STAGES, fetchAdminDailyMis } from "./adminDailyMis.service.js";

export const MAX_FORECAST_DAYS = 10;

export function parseForecastDays(value) {
  const days = Math.floor(Number(value) || 5);
  return Math.min(MAX_FORECAST_DAYS, Math.max(1, days));
}

export function forecastDates(todayYmd, days) {
  const start = moment(todayYmd, "YYYY-MM-DD");
  return Array.from({ length: days }, (_, i) => start.clone().add(i, "days").format("YYYY-MM-DD"));
}

const num = (value) => Number(value) || 0;
const varietyKey = (plantId, subtypeId) => `${plantId || ""}:${subtypeId || ""}`;

/**
 * One row per variety: booked + out (dispatched) for the range, open plants due on each forecast date.
 * `varietyTable` is the admin-daily-mis variety table; `forecastRows` are { plantId, subtypeId, plantName, subtypeName, date, orders, plants }.
 */
export function buildMisMobileRows(varietyTable, forecastRows, dates) {
  const rows = new Map();
  const rowFor = (plantId, subtypeId, plantName, subtypeName) => {
    const key = varietyKey(plantId, subtypeId);
    if (!rows.has(key)) {
      rows.set(key, {
        plantId: plantId ? String(plantId) : "",
        subtypeId: subtypeId ? String(subtypeId) : "",
        plantName: plantName || "Other",
        subtypeName: subtypeName || "Other",
        booked: { orders: 0, plants: 0 },
        out: { orders: 0, plants: 0 },
        forecast: dates.map((date) => ({ date, orders: 0, plants: 0 })),
        forecastTotal: 0,
      });
    }
    return rows.get(key);
  };

  for (const item of varietyTable || []) {
    const row = rowFor(item.plantId, item.subtypeId, item.plantName, item.subtype);
    row.booked = { orders: num(item.booking?.orders), plants: num(item.booking?.plants) };
    row.out = { orders: num(item.delivery?.dispatched?.orders), plants: num(item.delivery?.dispatched?.plants) };
  }

  for (const item of forecastRows || []) {
    const index = dates.indexOf(item.date);
    if (index < 0) continue;
    const row = rowFor(item.plantId, item.subtypeId, item.plantName, item.subtypeName);
    row.forecast[index].orders += num(item.orders);
    row.forecast[index].plants += num(item.plants);
    row.forecastTotal += num(item.plants);
  }

  const list = [...rows.values()].filter((row) => row.booked.plants || row.out.plants || row.forecastTotal);
  list.sort(
    (a, b) =>
      b.booked.plants + b.forecastTotal - (a.booked.plants + a.forecastTotal) ||
      a.plantName.localeCompare(b.plantName) ||
      a.subtypeName.localeCompare(b.subtypeName)
  );

  const totals = {
    booked: list.reduce((acc, row) => acc + row.booked.plants, 0),
    out: list.reduce((acc, row) => acc + row.out.plants, 0),
    forecast: dates.map((date, i) => ({ date, plants: list.reduce((acc, row) => acc + row.forecast[i].plants, 0) })),
  };
  totals.forecastTotal = totals.forecast.reduce((acc, day) => acc + day.plants, 0);
  return { rows: list, totals };
}

/** Open plants due per variety per IST day; partially shipped orders count what is left to send. */
async function fetchForecastRows(dates) {
  const parsed = parseCentralReportDateRange(dates[0], dates[dates.length - 1]);
  return Order.aggregate([
    { $match: matchDeliveryDateInRange(parsed.rangeStart, parsed.rangeEnd) },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    {
      $addFields: {
        openPlants: {
          $cond: [
            { $and: [{ $eq: ["$orderStatus", "PARTIALLY_COMPLETED"] }, { $gt: ["$remainingPlants", 0] }] },
            "$remainingPlants",
            "$linePlantTotal",
          ],
        },
        day: istDateStringExpr("deliveryDate"),
      },
    },
    ...PLANT_SUBTYPE_STAGES,
    {
      $group: {
        _id: { plantId: "$plantName", subtypeId: "$plantSubtype", day: "$day" },
        plantName: { $first: "$_plantTypeName" },
        subtypeName: { $first: "$_subtypeName" },
        orders: { $sum: 1 },
        plants: { $sum: "$openPlants" },
      },
    },
    {
      $project: {
        _id: 0,
        plantId: "$_id.plantId",
        subtypeId: "$_id.subtypeId",
        date: "$_id.day",
        plantName: 1,
        subtypeName: 1,
        orders: 1,
        plants: 1,
      },
    },
  ]);
}

export async function fetchMisMobile({ startDate, endDate, days, today = getIstTodayYmd() } = {}) {
  const dates = forecastDates(today, parseForecastDays(days));
  const [mis, forecastRows] = await Promise.all([
    fetchAdminDailyMis(startDate || today, endDate || today),
    fetchForecastRows(dates),
  ]);
  if (mis.error) return mis;
  const { rows, totals } = buildMisMobileRows(mis.data.varietyTable, forecastRows, dates);
  return {
    data: {
      today,
      startDate: mis.data.startDate,
      endDate: mis.data.endDate,
      forecastDates: dates,
      totals: { ...totals, bookedOrders: num(mis.data.varietyTotals?.booking?.orders) },
      rows,
    },
  };
}
