/**
 * Daily Admin MIS WhatsApp digest (Marathi) — 7 PM IST.
 * Booking plant-wise, dispatch, payments, Ram Agri stock.
 */

import moment from "moment";
import Order from "../models/order.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import PaymentActivity from "../models/paymentActivity.model.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";
import { fetchAdminDailyMis } from "./adminDailyMis.service.js";
import { getIstTodayYmd, istDayBoundsFromYmd } from "../utility/istOrderDateStats.js";
import { formatAdminDailyMisMarathiMessages } from "../utility/adminDailyMisMarathiFormat.js";
import { alertAdmins } from "./whatsappAlertService.js";
import {
  collectPaymentAttachmentUrls,
} from "../utility/paymentAttachmentUrl.js";

function sumDispatchPlants(delivery = {}) {
  const keys = ["dispatched", "vehicleDispatched", "completed", "dispatchProcess"];
  let plants = 0;
  let orders = 0;
  for (const k of keys) {
    plants += Number(delivery[k]?.plants) || 0;
    orders += Number(delivery[k]?.orders) || 0;
  }
  return { plants, orders };
}

function varietyLabel(row = {}) {
  const plant = String(row.plantName || "Unknown").trim() || "Unknown";
  const subtype = String(row.subtype || "Other").trim() || "Other";
  return `${plant} / ${subtype}`;
}

function mapVarietyBookingRows(varietyRows = []) {
  return (varietyRows || [])
    .filter((row) => (Number(row.booking?.plants) || 0) > 0)
    .map((row) => ({
      label: varietyLabel(row),
      plant: String(row.plantName || "Unknown").trim() || "Unknown",
      subtype: String(row.subtype || "Other").trim() || "Other",
      plants: Number(row.booking?.plants) || 0,
      orders: Number(row.booking?.orders) || 0,
    }))
    .sort((a, b) => b.plants - a.plants || a.label.localeCompare(b.label));
}

function mapVarietyDispatchRows(varietyRows = []) {
  return (varietyRows || [])
    .map((row) => {
      const d = sumDispatchPlants(row.delivery);
      return {
        label: varietyLabel(row),
        plant: String(row.plantName || "Unknown").trim() || "Unknown",
        subtype: String(row.subtype || "Other").trim() || "Other",
        plants: d.plants,
        orders: d.orders,
      };
    })
    .filter((row) => row.plants > 0)
    .sort((a, b) => b.plants - a.plants || a.label.localeCompare(b.label));
}

async function fetchPaymentSnapshot(rangeStart, rangeEnd) {
  const collectedFromOrders = async (Model, sourceLabel) =>
    Model.aggregate([
      { $match: { orderStatus: { $nin: ["CANCELLED", "REJECTED"] } } },
      { $unwind: "$payment" },
      {
        $match: {
          "payment.paymentStatus": "COLLECTED",
          "payment.paymentDate": { $gte: rangeStart, $lte: rangeEnd },
        },
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          amount: { $sum: { $ifNull: ["$payment.paidAmount", 0] } },
        },
      },
    ]).then((rows) => ({ ...(rows[0] || {}), source: sourceLabel }));

  const [collectedActivity, collectedPlant, collectedAgri, pendingPlant, pendingAgri] =
    await Promise.all([
    PaymentActivity.aggregate([
      {
        $match: {
          $or: [
            {
              activityType: "PAYMENT_STATUS_CHANGED",
              newStatus: "COLLECTED",
              timestamp: { $gte: rangeStart, $lte: rangeEnd },
            },
            {
              activityType: "PAYMENT_ADDED",
              newStatus: "COLLECTED",
              timestamp: { $gte: rangeStart, $lte: rangeEnd },
            },
          ],
        },
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          amount: { $sum: { $ifNull: ["$paymentAmount", 0] } },
        },
      },
    ]),
    collectedFromOrders(Order, "plant"),
    collectedFromOrders(AgriSalesOrder, "agri"),
    Order.aggregate([
      {
        $match: {
          orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
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
    AgriSalesOrder.aggregate([
      {
        $match: {
          orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
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
  ]);

  const pendingSamples = [];

  const plantPending = await Order.aggregate([
    {
      $match: {
        orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
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
        paymentStatus: "$payment.paymentStatus",
        receiptPhoto: "$payment.receiptPhoto",
        screenshots: 1,
        farmerName: { $arrayElemAt: ["$_farmer.name", 0] },
      },
    },
    { $sort: { amount: -1 } },
    { $limit: 5 },
  ]);

  for (const p of plantPending) {
    pendingSamples.push({
      label: `#${p.orderId || "—"}`,
      amount: p.amount,
      source: "Plant",
      paymentStatus: p.paymentStatus || "PENDING",
      attachmentUrls: collectPaymentAttachmentUrls(
        { receiptPhoto: p.receiptPhoto },
        p.screenshots
      ),
    });
  }

  const agriPending = await AgriSalesOrder.aggregate([
    {
      $match: {
        orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
        "payment.paymentStatus": "PENDING",
      },
    },
    { $unwind: "$payment" },
    { $match: { "payment.paymentStatus": "PENDING" } },
    {
      $project: {
        orderNumber: 1,
        amount: "$payment.paidAmount",
        paymentStatus: "$payment.paymentStatus",
        receiptPhoto: "$payment.receiptPhoto",
        screenshots: 1,
        customerName: 1,
      },
    },
    { $sort: { amount: -1 } },
    { $limit: 3 },
  ]);

  for (const p of agriPending) {
    pendingSamples.push({
      label: p.orderNumber || p.customerName || "Agri",
      amount: p.amount,
      source: "Ram Agri",
      paymentStatus: p.paymentStatus || "PENDING",
      attachmentUrls: collectPaymentAttachmentUrls(
        { receiptPhoto: p.receiptPhoto },
        p.screenshots
      ),
    });
  }

  pendingSamples.sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0));

  const collected = collectedActivity[0] || {};
  const fromPayments = {
    count: (collectedPlant.count || 0) + (collectedAgri.count || 0),
    amount: (collectedPlant.amount || 0) + (collectedAgri.amount || 0),
  };
  const pp = pendingPlant[0] || {};
  const pa = pendingAgri[0] || {};

  return {
    collectedTodayCount: Math.max(collected.count || 0, fromPayments.count),
    collectedTodayAmount: Math.max(collected.amount || 0, fromPayments.amount),
    pendingCount: (pp.count || 0) + (pa.count || 0),
    pendingAmount: (pp.amount || 0) + (pa.amount || 0),
    pendingSamples,
  };
}

async function fetchRamAgriStockSnapshot() {
  const crops = await RamAgriInputsProduct.find({ isActive: { $ne: false } })
    .select("cropName varieties")
    .populate("varieties.primaryUnit", "abbreviation name")
    .lean();

  const rows = [];
  let totalLines = 0;

  for (const crop of crops) {
    for (const v of crop.varieties || []) {
      if (v.isActive === false) continue;
      const stock = Number(v.currentStock) || 0;
      totalLines += 1;
      rows.push({
        label: `${crop.cropName || "—"} / ${v.name || "—"}`,
        stock,
        unit: v.primaryUnit?.abbreviation || v.primaryUnit?.name || "",
      });
    }
  }

  rows.sort((a, b) => b.stock - a.stock);
  return { rows, totalLines };
}

/**
 * Build snapshot for today (IST) or a given YYYY-MM-DD.
 * @param {string} [dateKey]
 */
export async function buildAdminDailyMisWhatsappSnapshot(dateKey) {
  const ymd = dateKey || getIstTodayYmd();
  const { start: rangeStart, end: rangeEnd } = istDayBoundsFromYmd(ymd);

  const [misResult, payments, ramAgri] = await Promise.all([
    fetchAdminDailyMis(ymd, ymd, {}),
    fetchPaymentSnapshot(rangeStart, rangeEnd),
    fetchRamAgriStockSnapshot(),
  ]);

  if (misResult.error) {
    throw new Error(misResult.error);
  }

  const mis = misResult.data || {};
  const todayRow =
    (mis.days || []).find((d) => d.date === ymd) ||
    (mis.days || []).find((d) => !d.isPastDue) ||
    null;

  const varietyTable = mis.varietyTable || [];
  const bookingByPlant = mapVarietyBookingRows(varietyTable);
  const dispatchByPlant = mapVarietyDispatchRows(varietyTable);

  const bookingTotal = todayRow?.booking || mis.totals?.booking || { plants: 0, orders: 0 };
  const dispatchFromToday = todayRow?.delivery ? sumDispatchPlants(todayRow.delivery) : { plants: 0, orders: 0 };

  return {
    dateKey: ymd,
    bookingByPlant,
    dispatchByPlant,
    bookingTotal: {
      plants: bookingTotal.plants || 0,
      orders: bookingTotal.orders || 0,
    },
    dispatchTotal: dispatchFromToday,
    payments,
    ramAgriStock: ramAgri.rows,
    ramAgriStockTotal: ramAgri.totalLines,
    generatedAt: moment().utcOffset(330).format("YYYY-MM-DD HH:mm"),
  };
}

/**
 * Build Marathi message chunks and send to admin WhatsApp numbers.
 * @param {string} [dateKey]
 */
export async function sendAdminDailyMisMarathiAlert(dateKey) {
  if (process.env.WHATSAPP_ALERTS_ENABLED !== "true") {
    return { skipped: true, reason: "alerts_disabled" };
  }

  const snapshot = await buildAdminDailyMisWhatsappSnapshot(dateKey);
  const chunks = formatAdminDailyMisMarathiMessages(snapshot);

  let delivered = 0;
  const chunkResults = [];

  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : "";
    const result = await alertAdmins(prefix + chunks[i], "admin daily MIS");
    chunkResults.push(result);
    delivered += result?.delivered || 0;
  }

  return {
    sent: delivered > 0,
    delivered,
    chunks: chunks.length,
    dateKey: snapshot.dateKey,
    snapshot,
    chunkResults,
  };
}
