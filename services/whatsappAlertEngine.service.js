/**
 * WhatsApp alert engine — rule-based automated alerts on the scanned ERP session.
 *
 * Event-driven: big orders on create/update.
 * Scheduled: date-wise FIFO booking capacity digest, operational backlog digest.
 *
 * Env (see .env.example):
 *   WHATSAPP_ALERT_BIG_ORDER_QTY=10000          (default for non-Banana)
 *   WHATSAPP_ALERT_BIG_ORDER_QTY_BANANA=6000    (Banana / केळी)
 *   WHATSAPP_ALERT_SLOT_SCAN_CRON=0 9,14,18 * * *
 *   WHATSAPP_ALERT_OPS_CRON=0 8 * * *
 */

import mongoose from "mongoose";
import moment from "moment";
import Order from "../models/order.model.js";
import {
  sendBigOrderAlert,
  sendBookingCapacityDigest,
  sendOpsAlertsDigest,
} from "./whatsappAlertService.js";
import { fetchSystemAlertsSnapshot } from "./whatsappReportData.service.js";
import {
  shouldSkipAlert,
  markAlertSent,
} from "./whatsappAlertDedupe.service.js";
import { isBananaPlantName } from "../utility/watiPlantText.js";
import { loadCapacityBoardPayload } from "../controllers/capacitySheet.controller.js";
import {
  buildBookingCapacityVarieties,
  formatBookingCapacityDigestMessages,
} from "../utility/bookingCapacityDigestFormat.js";
import { IST_OFFSET } from "../utility/istSlotDate.js";

export function getAlertEngineRules() {
  return {
    bigOrderQty: parseInt(process.env.WHATSAPP_ALERT_BIG_ORDER_QTY || "10000", 10),
    bigOrderQtyBanana: parseInt(
      process.env.WHATSAPP_ALERT_BIG_ORDER_QTY_BANANA || "6000",
      10
    ),
    slotLowUtilPct: parseInt(
      process.env.WHATSAPP_ALERT_SLOT_LOW_UTIL_PCT || "80",
      10
    ),
    slotLowAvailAbs: parseInt(
      process.env.WHATSAPP_ALERT_SLOT_LOW_ABS || "1000",
      10
    ),
    slotHighAvailPct: parseInt(
      process.env.WHATSAPP_ALERT_SLOT_HIGH_AVAIL_PCT || "60",
      10
    ),
    slotHighAvailAbs: parseInt(
      process.env.WHATSAPP_ALERT_SLOT_HIGH_ABS || "5000",
      10
    ),
    slotDigestMaxRows: parseInt(
      process.env.WHATSAPP_ALERT_SLOT_DIGEST_MAX || "12",
      10
    ),
  };
}

export function orderPlantQty(order = {}) {
  const base = Number(order.numberOfPlants) || 0;
  const extra = Number(order.additionalPlants) || 0;
  const total = Number(order.totalPlants);
  if (total > 0) return total;
  return base + extra;
}

/** Plant display name from order (populated PlantCms or snapshot). */
export function orderPlantNameForAlert(order = {}) {
  const plant = order.plantName;
  if (plant && typeof plant === "object") {
    return String(plant.name || plant.plantName || "").trim();
  }
  return String(
    order.plantNameSnapshot || order.plantName || order.cropName || ""
  ).trim();
}

/**
 * Banana / केळी → 6,000 (env WHATSAPP_ALERT_BIG_ORDER_QTY_BANANA).
 * Other plants → 10,000 (env WHATSAPP_ALERT_BIG_ORDER_QTY).
 */
export function bigOrderThresholdForOrder(order = {}, rules = getAlertEngineRules()) {
  const plant = orderPlantNameForAlert(order);
  const subtype = String(
    order.plantSubtypeSnapshot ||
      order.plantSubtypeName ||
      (typeof order.plantSubtype === "string" ? order.plantSubtype : "") ||
      ""
  ).trim();
  if (isBananaPlantName(plant, subtype)) {
    return Math.max(1, Number(rules.bigOrderQtyBanana) || 6000);
  }
  return Math.max(1, Number(rules.bigOrderQty) || 10000);
}

/** Classify a slot row for alerting. Pure — unit tested. */
export function classifySlotRow(row, rules = getAlertEngineRules()) {
  const cap = Number(row.totalPlants) || 0;
  const booked = Number(row.bookedPlants) || 0;
  const avail = Number(row.availablePlants) ?? cap - booked;

  if (row.status === "overbooked" || avail < 0 || (cap > 0 && booked > cap)) {
    return "overbooked";
  }
  if (avail <= 0 || row.status === "full") {
    return "full";
  }

  const utilPct = cap > 0 ? Math.round((booked / cap) * 100) : booked > 0 ? 100 : 0;
  const availPct = cap > 0 ? Math.round((avail / cap) * 100) : 0;

  if (
    utilPct >= rules.slotLowUtilPct ||
    avail <= rules.slotLowAvailAbs ||
    row.status === "low"
  ) {
    return "low";
  }

  if (
    availPct >= rules.slotHighAvailPct &&
    avail >= rules.slotHighAvailAbs &&
    cap >= rules.slotHighAvailAbs
  ) {
    return "high";
  }

  return null;
}

async function loadOrderForEngine(orderOrId) {
  const orderId = orderOrId?._id || orderOrId;
  if (!orderId || !mongoose.isValidObjectId(String(orderId))) return null;
  return Order.findById(orderId)
    .populate("farmer", "name village taluka talukaName")
    .populate("salesPerson", "name")
    .populate("plantName", "name")
    .lean();
}

/**
 * Fire on new order — big quantity threshold.
 */
export async function evaluateOrderAlertsOnCreate(orderOrId, { isUpdate = false } = {}) {
  if (process.env.WHATSAPP_ALERTS_ENABLED !== "true") {
    return { skipped: true, reason: "alerts_disabled" };
  }

  const order =
    (await loadOrderForEngine(orderOrId)) ||
    (orderOrId && typeof orderOrId === "object" ? orderOrId : null);
  if (!order) return { skipped: true, reason: "order_not_found" };

  const rules = getAlertEngineRules();
  const qty = orderPlantQty(order);
  const threshold = bigOrderThresholdForOrder(order, rules);
  if (qty < threshold) {
    return { skipped: true, reason: "below_threshold", qty, threshold };
  }

  const orderKey = String(order._id || order.orderId || "");
  // Allow a second alert when qty is edited up (update path); create still dedupes.
  const dedupeKey = isUpdate ? `big-order-update:${orderKey}:${qty}` : `big-order:${orderKey}`;
  if (shouldSkipAlert(dedupeKey)) {
    return { skipped: true, reason: "dedupe", qty, threshold };
  }

  const delivery = await sendBigOrderAlert(order, {
    qty,
    threshold,
    isUpdate: Boolean(isUpdate),
  });
  if (delivery?.delivered > 0) {
    markAlertSent(dedupeKey);
  }
  return { sent: true, qty, threshold, delivery, isUpdate: Boolean(isUpdate) };
}

/**
 * Fire when order qty is edited above threshold.
 */
export async function evaluateOrderAlertsOnUpdate(
  updatedOrder,
  editHistory = []
) {
  if (process.env.WHATSAPP_ALERTS_ENABLED !== "true") {
    return { skipped: true, reason: "alerts_disabled" };
  }

  const qtyChanged = editHistory.some(
    (e) => e?.field === "numberOfPlants" || e?.field === "additionalPlants"
  );
  if (!qtyChanged) return { skipped: true, reason: "qty_unchanged" };

  const plain = updatedOrder?.toObject?.() ?? updatedOrder;
  return evaluateOrderAlertsOnCreate(plain, { isUpdate: true });
}

/**
 * Date-wise FIFO booking capacity (replaces old low/high/overbooked slot alerts).
 * Uses capacity board ready vs booked, then locks earlier surplus for later shorts.
 */
export async function runSlotAvailabilityAlertScan() {
  if (process.env.WHATSAPP_ALERTS_ENABLED !== "true") {
    return { skipped: true, reason: "alerts_disabled" };
  }
  if (process.env.WHATSAPP_ALERT_BOOKING_CAPACITY_ENABLED !== "true") {
    return { skipped: true, reason: "booking_capacity_disabled" };
  }

  const now = moment().utcOffset(IST_OFFSET);
  const board = await loadCapacityBoardPayload(now, { groupDays: 1 });
  const varieties = buildBookingCapacityVarieties(board.rows || [], board.today);
  const formatted = formatBookingCapacityDigestMessages({
    varieties,
    today: board.today,
    tableDays: board.tableDays || 30,
    generatedAt: now.toISOString(),
  });

  if (formatted.empty || !formatted.chunks.length) {
    return {
      skipped: true,
      reason: "nothing_to_book",
      scanned: (board.rows || []).length,
    };
  }

  const delivery = await sendBookingCapacityDigest({ chunks: formatted.chunks });

  return {
    sent: true,
    kind: "booking_capacity_fifo",
    varietyCount: formatted.varietyCount,
    totalCanBook: formatted.totalCanBook,
    chunks: formatted.chunks.length,
    scanned: (board.rows || []).length,
    delivery,
  };
}

/**
 * Morning ops digest — stuck orders, payment pending, slot overflow counts.
 */
export async function runOperationalAlertsScan() {
  if (process.env.WHATSAPP_ALERTS_ENABLED !== "true") {
    return { skipped: true, reason: "alerts_disabled" };
  }
  if (process.env.WHATSAPP_ALERT_OPS_ENABLED !== "true") {
    return { skipped: true, reason: "ops_digest_disabled" };
  }

  const dedupeKey = `ops-digest:${new Date().toISOString().slice(0, 10)}`;
  if (shouldSkipAlert(dedupeKey)) {
    return { skipped: true, reason: "dedupe" };
  }

  const { text, counts } = await fetchSystemAlertsSnapshot();
  const hasSignal =
    (counts?.stuckAccepted || 0) > 0 ||
    (counts?.stuckFarmReady || 0) > 0 ||
    (counts?.paymentPending || 0) > 0 ||
    (counts?.oldPendingNew || 0) > 0 ||
    (counts?.overflowSlots || 0) > 0;

  if (!hasSignal) {
    return { skipped: true, reason: "all_clear", counts };
  }

  const delivery = await sendOpsAlertsDigest({ text, counts });
  if (delivery?.delivered > 0) {
    markAlertSent(dedupeKey);
  }
  return { sent: true, counts, delivery };
}

/** Run all scheduled scans (cron entry). */
export async function runScheduledAlertEngine() {
  const slot = await runSlotAvailabilityAlertScan();
  return { slot };
}

export async function runDailyOpsAlertEngine() {
  return runOperationalAlertsScan();
}
