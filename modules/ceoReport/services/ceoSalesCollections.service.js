import Order from "../../../models/order.model.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
} from "../../../utility/istOrderDateStats.js";
import { fetchAdminSalesMis, fetchAdminDealerMis } from "../../../services/adminMisBreakdown.service.js";
import { parseCeoReportQuery } from "../utility/ceoQueryParams.js";
import { generateIstMonthKeys, istMonthStringExpr } from "../utility/istMonthStats.js";

export async function fetchCeoSalesCollections(query = {}) {
  const opts = parseCeoReportQuery(query);
  if (opts.error) return { error: opts.error, statusCode: 400 };

  const { rangeStart, rangeEnd, startYmd, endYmd, depth, extraMatch } = opts;

  const [summaryAgg, periodAgg, topSales, topDealers] = await Promise.all([
    Order.aggregate([
      {
        $match: {
          ...orderStatusExcludeMatch(),
          ...extraMatch,
          orderBookingDate: { $gte: rangeStart, $lte: rangeEnd },
        },
      },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      {
        $addFields: {
          _orderAmount: {
            $multiply: [
              "$linePlantTotal",
              { $ifNull: ["$rate", 0] },
            ],
          },
          _collected: {
            $reduce: {
              input: {
                $filter: {
                  input: { $ifNull: ["$payment", []] },
                  as: "p",
                  cond: { $eq: ["$$p.paymentStatus", "COLLECTED"] },
                },
              },
              initialValue: 0,
              in: { $add: ["$$value", { $ifNull: ["$$this.paidAmount", 0] }] },
            },
          },
        },
      },
      {
        $group: {
          _id: null,
          bookedOrders: { $sum: 1 },
          bookedPlants: { $sum: "$linePlantTotal" },
          bookedValue: { $sum: "$_orderAmount" },
          collected: { $sum: "$_collected" },
        },
      },
    ]),
    depth === "summary"
      ? Promise.resolve([])
      : Order.aggregate([
          {
            $match: {
              ...orderStatusExcludeMatch(),
              ...extraMatch,
              orderBookingDate: { $gte: rangeStart, $lte: rangeEnd },
            },
          },
          { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
          {
            $addFields: {
              _month: istMonthStringExpr("orderBookingDate"),
              _orderAmount: {
                $multiply: ["$linePlantTotal", { $ifNull: ["$rate", 0] }],
              },
              _collected: {
                $reduce: {
                  input: {
                    $filter: {
                      input: { $ifNull: ["$payment", []] },
                      as: "p",
                      cond: { $eq: ["$$p.paymentStatus", "COLLECTED"] },
                    },
                  },
                  initialValue: 0,
                  in: { $add: ["$$value", { $ifNull: ["$$this.paidAmount", 0] }] },
                },
              },
            },
          },
          {
            $group: {
              _id: "$_month",
              bookedOrders: { $sum: 1 },
              bookedPlants: { $sum: "$linePlantTotal" },
              bookedValue: { $sum: "$_orderAmount" },
              collected: { $sum: "$_collected" },
            },
          },
          { $sort: { _id: 1 } },
        ]),
    fetchAdminSalesMis(startYmd, endYmd, {}),
    fetchAdminDealerMis(startYmd, endYmd, {}),
  ]);

  const s = summaryAgg[0] || {};
  const bookedValue = s.bookedValue ?? 0;
  const collected = s.collected ?? 0;

  const payload = {
    tab: "sales-collections",
    timezone: "Asia/Kolkata",
    depth,
    range: { startDate: startYmd, endDate: endYmd },
    summary: {
      bookedValue: { amount: bookedValue, orders: s.bookedOrders ?? 0, plants: s.bookedPlants ?? 0 },
      collected: { amount: collected },
      outstanding: { amount: Math.max(0, bookedValue - collected) },
      collectionRate: bookedValue > 0 ? Math.round((collected / bookedValue) * 100) : 0,
    },
    topSales: (topSales?.data?.rows || [])
      .slice(0, 10)
      .map((r) => ({
        id: r.personId,
        name: r.personName,
        bookedPlants: r.booking?.plants ?? 0,
        bookedOrders: r.booking?.orders ?? 0,
      })),
    topDealers: (topDealers?.data?.rows || [])
      .slice(0, 10)
      .map((r) => ({
        id: r.personId,
        name: r.personName,
        bookedPlants: r.booking?.plants ?? 0,
        bookedOrders: r.booking?.orders ?? 0,
      })),
  };

  if (depth !== "summary") {
    const monthKeys = generateIstMonthKeys(startYmd, endYmd);
    const byMonth = new Map(periodAgg.map((r) => [r._id, r]));
    payload.periods = monthKeys.map((key) => {
      const r = byMonth.get(key) || {};
      const bv = r.bookedValue ?? 0;
      const col = r.collected ?? 0;
      return {
        key,
        label: key,
        bookedValue: bv,
        collected: col,
        outstanding: Math.max(0, bv - col),
        bookedOrders: r.bookedOrders ?? 0,
        bookedPlants: r.bookedPlants ?? 0,
      };
    });
  }

  return { data: payload };
}
