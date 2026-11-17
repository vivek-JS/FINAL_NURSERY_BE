/**
 * Intraday 2.5h English WhatsApp ops report.
 * Booking, dispatch (shed/batch), salesperson, payments for [now-2.5h, now).
 */

import mongoose from "mongoose";
import moment from "moment";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import Dispatch from "../models/dispatch.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
  getIstTodayYmd,
  istDayBoundsFromYmd,
} from "../utility/istOrderDateStats.js";
import {
  buildDispatchDayLines,
} from "./dispatchDaySummary.service.js";
import {
  INTRADAY_WINDOW_MS,
  intradayWindowBounds,
} from "../utility/intradayOpsWindow.js";
import { formatIntradayOpsEnglishMessages } from "../utility/intradayOpsEnglishFormat.js";
import { alertAdmins } from "./whatsappAlertService.js";

const idStr = (v) => (v == null || v === "" ? "" : String(v));
const toInt = (v) => Math.max(0, Math.floor(Number(v) || 0));

function bookingTimeExpr() {
  return { $ifNull: ["$orderBookingDate", "$createdAt"] };
}

async function fetchBookingAndSales(from, to) {
  const rows = await Order.aggregate([
    { $match: orderStatusExcludeMatch() },
    {
      $match: {
        $expr: {
          $and: [
            { $gte: [bookingTimeExpr(), from] },
            { $lt: [bookingTimeExpr(), to] },
          ],
        },
      },
    },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    {
      $lookup: {
        from: "plantcms",
        localField: "plantName",
        foreignField: "_id",
        as: "_plant",
        pipeline: [{ $project: { name: 1, subtypes: { _id: 1, name: 1 } } }],
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "salesPerson",
        foreignField: "_id",
        as: "_sales",
        pipeline: [{ $project: { name: 1 } }],
      },
    },
    {
      $addFields: {
        _plantDoc: { $arrayElemAt: ["$_plant", 0] },
        _salesName: {
          $ifNull: [{ $arrayElemAt: ["$_sales.name", 0] }, "Unknown"],
        },
      },
    },
    {
      $addFields: {
        _plantLabel: {
          $ifNull: [
            "$plantNameSnapshot",
            { $ifNull: ["$_plantDoc.name", "Unknown"] },
          ],
        },
        _subtypeLabel: {
          $ifNull: [
            "$plantSubtypeSnapshot",
            {
              $let: {
                vars: {
                  match: {
                    $first: {
                      $filter: {
                        input: { $ifNull: ["$_plantDoc.subtypes", []] },
                        as: "s",
                        cond: { $eq: ["$$s._id", "$plantSubtype"] },
                      },
                    },
                  },
                },
                in: { $ifNull: ["$$match.name", "Other"] },
              },
            },
          ],
        },
        _amount: {
          $multiply: [
            { $ifNull: ["$rate", 0] },
            "$linePlantTotal",
          ],
        },
      },
    },
    {
      $facet: {
        byVariety: [
          {
            $group: {
              _id: { plant: "$_plantLabel", subtype: "$_subtypeLabel" },
              plants: { $sum: "$linePlantTotal" },
              orders: { $sum: 1 },
            },
          },
          { $sort: { plants: -1 } },
        ],
        bySales: [
          {
            $group: {
              _id: { id: "$salesPerson", name: "$_salesName" },
              plants: { $sum: "$linePlantTotal" },
              amount: { $sum: "$_amount" },
              orders: { $sum: 1 },
            },
          },
          { $sort: { plants: -1 } },
        ],
        bySalesVariety: [
          {
            $group: {
              _id: {
                id: "$salesPerson",
                name: "$_salesName",
                plant: "$_plantLabel",
                subtype: "$_subtypeLabel",
              },
              plants: { $sum: "$linePlantTotal" },
              amount: { $sum: "$_amount" },
              orders: { $sum: 1 },
            },
          },
          { $sort: { plants: -1 } },
        ],
        totals: [
          {
            $group: {
              _id: null,
              plants: { $sum: "$linePlantTotal" },
              orders: { $sum: 1 },
              amount: { $sum: "$_amount" },
            },
          },
        ],
      },
    },
  ]);

  const facet = rows[0] || {};
  const totals = facet.totals?.[0] || { plants: 0, orders: 0, amount: 0 };

  const bookingByPlant = (facet.byVariety || []).map((r) => {
    const plant = String(r._id?.plant || "Unknown").trim() || "Unknown";
    const subtype = String(r._id?.subtype || "Other").trim() || "Other";
    return {
      plant,
      subtype,
      label: `${plant} / ${subtype}`,
      plants: toInt(r.plants),
      orders: toInt(r.orders),
    };
  });

  const varietiesBySalesKey = new Map();
  for (const r of facet.bySalesVariety || []) {
    const key = String(r._id?.id || r._id?.name || "unknown");
    const plant = String(r._id?.plant || "Unknown").trim() || "Unknown";
    const subtype = String(r._id?.subtype || "Other").trim() || "Other";
    if (!varietiesBySalesKey.has(key)) varietiesBySalesKey.set(key, []);
    varietiesBySalesKey.get(key).push({
      plant,
      subtype,
      label: `${plant} / ${subtype}`,
      plants: toInt(r.plants),
      amount: Math.round(Number(r.amount) || 0),
      orders: toInt(r.orders),
    });
  }

  const salesperson = (facet.bySales || []).map((r) => {
    const key = String(r._id?.id || r._id?.name || "unknown");
    return {
      name: String(r._id?.name || "Unknown").trim() || "Unknown",
      plants: toInt(r.plants),
      amount: Math.round(Number(r.amount) || 0),
      orders: toInt(r.orders),
      varieties: varietiesBySalesKey.get(key) || [],
    };
  });

  return {
    bookingByPlant,
    bookingTotal: {
      plants: toInt(totals.plants),
      orders: toInt(totals.orders),
    },
    salesperson,
    salespersonTotal: {
      plants: toInt(totals.plants),
      amount: Math.round(Number(totals.amount) || 0),
    },
  };
}

async function fetchDispatchWindow(from, to) {
  const outwards = await PlantOutward.aggregate([
    {
      $match: {
        secondaryOutward: {
          $elemMatch: {
            linkedDispatchId: { $exists: true, $ne: null },
            secondaryOutwardDate: { $gte: from, $lt: to },
          },
        },
      },
    },
    { $project: { batchId: 1, secondaryOutward: 1 } },
    { $unwind: "$secondaryOutward" },
    {
      $match: {
        "secondaryOutward.linkedDispatchId": { $exists: true, $ne: null },
        "secondaryOutward.secondaryOutwardDate": { $gte: from, $lt: to },
      },
    },
    {
      $project: {
        _id: 0,
        batchId: 1,
        soId: "$secondaryOutward._id",
        dispatchId: "$secondaryOutward.linkedDispatchId",
        orderId: "$secondaryOutward.linkedOrderId",
        plants: "$secondaryOutward.totalQuantity",
        shed: "$secondaryOutward.pollyhouse",
        plantRowIndex: "$secondaryOutward.linkedDispatchPlantRowIndex",
        batchNumber: "$secondaryOutward.orderLinkSnapshot.batchNumber",
        sowingDate: "$secondaryOutward.sowingDate",
        sowBucket: "$secondaryOutward.sowBucket",
        cavity: "$secondaryOutward.cavity",
        at: "$secondaryOutward.secondaryOutwardDate",
      },
    },
  ]);

  if (!outwards.length) {
    return {
      dispatchGroups: [],
      dispatchByPlant: [],
      dispatchTotal: { plants: 0 },
    };
  }

  const ids = (key) => [
    ...new Set(
      outwards.map((o) => idStr(o[key])).filter((id) => mongoose.isValidObjectId(id))
    ),
  ];

  const [dispatches, orders, batches] = await Promise.all([
    Dispatch.find({ _id: { $in: ids("dispatchId") }, isDeleted: { $ne: true } })
      .select(
        "transportId vehicleName vehicleNumber driverName isInstantPickup shedReturns plantsDetails"
      )
      .lean(),
    Order.find({ _id: { $in: ids("orderId") } })
      .select("orderId publicOrderCode farmer")
      .populate("farmer", "name village")
      .lean(),
    DispatchBatch.find({ _id: { $in: ids("batchId") } })
      .select("batchNumber plantCmsId plantSubtypeId")
      .lean(),
  ]);

  const plantIds = new Set();
  for (const b of batches) if (b.plantCmsId) plantIds.add(idStr(b.plantCmsId));
  for (const d of dispatches) {
    for (const p of d.plantsDetails || []) if (p.plantId) plantIds.add(idStr(p.plantId));
  }
  const cms = await PlantCms.find({
    _id: { $in: [...plantIds].filter((id) => mongoose.isValidObjectId(id)) },
  })
    .select("name subtypes._id subtypes.name")
    .lean();
  const cmsById = new Map(cms.map((p) => [idStr(p._id), p]));
  const plantNameOf = (plantId, subtypeId) => {
    const p = cmsById.get(plantId);
    return {
      plant: p?.name || "",
      subtype: (p?.subtypes || []).find((s) => idStr(s._id) === subtypeId)?.name || "",
    };
  };

  const lines = buildDispatchDayLines({
    outwards,
    dispatchById: new Map(dispatches.map((d) => [idStr(d._id), d])),
    orderById: new Map(orders.map((o) => [idStr(o._id), o])),
    batchById: new Map(batches.map((b) => [idStr(b._id), b])),
    plantNameOf,
  });

  const groupMap = new Map();
  const plantMap = new Map();
  let grand = 0;

  for (const line of lines) {
    const plant = String(line.crop || "Unknown").trim() || "Unknown";
    const subtype = String(line.subtype || "Other").trim() || "Other";
    const label = `${plant} / ${subtype}`;
    const key = label.toLowerCase();
    if (!groupMap.has(key)) {
      groupMap.set(key, { label, plant, subtype, plants: 0, lines: [] });
    }
    const g = groupMap.get(key);
    g.plants += toInt(line.plants);
    g.lines.push({
      shed: String(line.shed || "").trim() || "—",
      batch: String(line.batch || "").trim(),
      plants: toInt(line.plants),
    });
    plantMap.set(plant, (plantMap.get(plant) || 0) + toInt(line.plants));
    grand += toInt(line.plants);
  }

  // Merge shed/batch duplicates inside each variety group
  for (const g of groupMap.values()) {
    const merged = new Map();
    for (const row of g.lines) {
      const k = `${row.shed}||${row.batch}`;
      merged.set(k, (merged.get(k) || 0) + row.plants);
    }
    g.lines = [...merged.entries()]
      .map(([k, plants]) => {
        const [shed, batch] = k.split("||");
        return { shed, batch, plants };
      })
      .sort((a, b) => b.plants - a.plants);
  }

  const dispatchGroups = [...groupMap.values()].sort(
    (a, b) => b.plants - a.plants || a.label.localeCompare(b.label)
  );
  const dispatchByPlant = [...plantMap.entries()]
    .map(([plant, plants]) => ({ plant, plants }))
    .sort((a, b) => b.plants - a.plants || a.plant.localeCompare(b.plant));

  return {
    dispatchGroups,
    dispatchByPlant,
    dispatchTotal: { plants: grand },
  };
}

async function fetchPayments(from, to) {
  const [collected, pendingAgg, pendingSamples] = await Promise.all([
    Order.aggregate([
      { $match: orderStatusExcludeMatch() },
      { $unwind: "$payment" },
      {
        $match: {
          "payment.paymentStatus": { $in: ["COLLECTED", "BANK_VERIFIED"] },
          $expr: {
            $and: [
              {
                $gte: [
                  { $ifNull: ["$payment.paymentDate", "$payment.createdAt"] },
                  from,
                ],
              },
              {
                $lt: [
                  { $ifNull: ["$payment.paymentDate", "$payment.createdAt"] },
                  to,
                ],
              },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          amount: { $sum: { $ifNull: ["$payment.paidAmount", 0] } },
        },
      },
    ]),
    Order.aggregate([
      {
        $match: {
          ...orderStatusExcludeMatch(),
          "payment.paymentStatus": "PENDING",
        },
      },
      { $unwind: "$payment" },
      { $match: { "payment.paymentStatus": "PENDING" } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          amount: { $sum: { $ifNull: ["$payment.paidAmount", 0] } },
        },
      },
    ]),
    Order.aggregate([
      {
        $match: {
          ...orderStatusExcludeMatch(),
          "payment.paymentStatus": "PENDING",
        },
      },
      { $unwind: "$payment" },
      { $match: { "payment.paymentStatus": "PENDING" } },
      {
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "_farmer",
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      {
        $project: {
          orderId: 1,
          amount: "$payment.paidAmount",
          farmerName: { $arrayElemAt: ["$_farmer.name", 0] },
        },
      },
      { $sort: { amount: -1 } },
      { $limit: 5 },
    ]),
  ]);

  const c = collected[0] || {};
  const p = pendingAgg[0] || {};
  return {
    collectedAmount: Math.round(Number(c.amount) || 0),
    collectedCount: toInt(c.count),
    pendingAmount: Math.round(Number(p.amount) || 0),
    pendingCount: toInt(p.count),
    pendingSamples: (pendingSamples || []).map((row) => ({
      label: `ORD-${row.orderId || "—"}`,
      farmerName: row.farmerName || "",
      amount: Math.round(Number(row.amount) || 0),
    })),
  };
}

/**
 * @param {{ from?: Date, to?: Date, windowMs?: number }} [opts]
 */
export async function buildIntradayOpsWhatsappSnapshot(opts = {}) {
  const to = opts.to ? new Date(opts.to) : new Date();
  const windowMs = opts.windowMs || INTRADAY_WINDOW_MS;
  const { from } = opts.from
    ? { from: new Date(opts.from) }
    : intradayWindowBounds(to, windowMs);
  const end = opts.from && opts.to ? new Date(opts.to) : to;

  const [bookingSales, dispatch, payments] = await Promise.all([
    fetchBookingAndSales(from, end),
    fetchDispatchWindow(from, end),
    fetchPayments(from, end),
  ]);

  return {
    from,
    to: end,
    windowMs,
    reportKind: "intraday",
    ...bookingSales,
    ...dispatch,
    payments,
    generatedAt: moment().utcOffset(330).format("YYYY-MM-DD HH:mm"),
  };
}

/**
 * Full IST calendar day summary (used for 9 PM day-end report).
 * @param {string} [dateKey] YYYY-MM-DD IST
 */
export async function buildDayEndOpsWhatsappSnapshot(dateKey) {
  const ymd = dateKey || getIstTodayYmd();
  const { start, end } = istDayBoundsFromYmd(ymd);
  // Queries use $lt endExclusive so the full day through 23:59:59.999 is included.
  const endExclusive = new Date(end.getTime() + 1);

  const [bookingSales, dispatch, payments] = await Promise.all([
    fetchBookingAndSales(start, endExclusive),
    fetchDispatchWindow(start, endExclusive),
    fetchPayments(start, endExclusive),
  ]);

  return {
    from: start,
    to: end,
    dateKey: ymd,
    reportKind: "dayEnd",
    ...bookingSales,
    ...dispatch,
    payments,
    generatedAt: moment().utcOffset(330).format("YYYY-MM-DD HH:mm"),
  };
}

async function sendOpsChunks(snapshot, context) {
  const chunks = formatIntradayOpsEnglishMessages(snapshot);
  let delivered = 0;
  const chunkResults = [];
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : "";
    const result = await alertAdmins(prefix + chunks[i], context);
    chunkResults.push(result);
    delivered += result?.delivered || 0;
  }
  return {
    sent: delivered > 0,
    delivered,
    chunks: chunks.length,
    from: snapshot.from,
    to: snapshot.to,
    dateKey: snapshot.dateKey,
    snapshot,
    chunkResults,
  };
}

/** Build English chunks and send to admin WhatsApp numbers. */
export async function sendIntradayOpsWhatsappAlert(opts = {}) {
  if (process.env.WHATSAPP_ALERTS_ENABLED !== "true") {
    return { skipped: true, reason: "alerts_disabled" };
  }
  if (process.env.WHATSAPP_INTRADAY_REPORT_ENABLED === "false") {
    return { skipped: true, reason: "intraday_disabled" };
  }

  const snapshot = await buildIntradayOpsWhatsappSnapshot(opts);
  return sendOpsChunks(snapshot, "intraday 2.5h ops");
}

/** Full-day English summary — scheduled 9:00 PM IST. */
export async function sendDayEndOpsWhatsappAlert(dateKey) {
  if (process.env.WHATSAPP_ALERTS_ENABLED !== "true") {
    return { skipped: true, reason: "alerts_disabled" };
  }
  if (process.env.WHATSAPP_DAY_END_REPORT_ENABLED === "false") {
    return { skipped: true, reason: "day_end_disabled" };
  }

  const snapshot = await buildDayEndOpsWhatsappSnapshot(dateKey);
  return sendOpsChunks(snapshot, "day-end daily ops");
}
