/**
 * WhatsApp alert engine — rule-based automated alerts on the scanned ERP session.
 *
 * Event-driven: big orders on create/update.
 * Scheduled: slot low/high/overbooked scans, operational backlog digest.
 *
 * Env (see .env.example):
 *   WHATSAPP_ALERT_BIG_ORDER_QTY=10000
 *   WHATSAPP_ALERT_SLOT_LOW_UTIL_PCT=80
 *   WHATSAPP_ALERT_SLOT_LOW_ABS=1000
 *   WHATSAPP_ALERT_SLOT_HIGH_AVAIL_PCT=60
 *   WHATSAPP_ALERT_SLOT_HIGH_ABS=5000
 *   WHATSAPP_ALERT_SLOT_SCAN_CRON=0 9,14,18 * * *
 *   WHATSAPP_ALERT_OPS_CRON=0 8 * * *
 */

import mongoose from "mongoose";
import Order from "../models/order.model.js";
import {
  sendBigOrderAlert,
  sendSlotAvailabilityDigest,
  sendOpsAlertsDigest,
} from "./whatsappAlertService.js";
import { fetchAvailabilityOverviewData } from "./whatsappReportAvailability.service.js";
import { fetchSystemAlertsSnapshot } from "./whatsappReportData.service.js";
import {
  shouldSkipAlert,
  markAlertSent,
} from "./whatsappAlertDedupe.service.js";

export function getAlertEngineRules() {
  return {
    bigOrderQty: parseInt(process.env.WHATSAPP_ALERT_BIG_ORDER_QTY || "10000", 10),
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

function slotDedupeKey(kind, row) {
  return `slot-${kind}:${row.slotId || row.plantId}:${row.subtypeId}:${row.startDay}:${row.month}`;
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
export async function evaluateOrderAlertsOnCreate(orderOrId) {
  if (process.env.WHATSAPP_ALERTS_ENABLED !== "true") {
    return { skipped: true, reason: "alerts_disabled" };
  }

  const order =
    (await loadOrderForEngine(orderOrId)) ||
    (orderOrId && typeof orderOrId === "object" ? orderOrId : null);
  if (!order) return { skipped: true, reason: "order_not_found" };

  const rules = getAlertEngineRules();
  const qty = orderPlantQty(order);
  if (qty < rules.bigOrderQty) {
    return { skipped: true, reason: "below_threshold", qty };
  }

  const orderKey = String(order._id || order.orderId || "");
  const dedupeKey = `big-order:${orderKey}`;
  if (shouldSkipAlert(dedupeKey)) {
    return { skipped: true, reason: "dedupe", qty };
  }

  const delivery = await sendBigOrderAlert(order, { qty, threshold: rules.bigOrderQty });
  if (delivery?.delivered > 0) {
    markAlertSent(dedupeKey);
  }
  return { sent: true, qty, delivery };
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
  return evaluateOrderAlertsOnCreate(plain);
}

/**
 * Scan all slots — low / full / overbooked / high availability.
 */
export async function runSlotAvailabilityAlertScan() {
  if (process.env.WHATSAPP_ALERTS_ENABLED !== "true") {
    return { skipped: true, reason: "alerts_disabled" };
  }

  const rules = getAlertEngineRules();
  const { rows, year } = await fetchAvailabilityOverviewData({});

  /** @type {object[]} */
  const low = [];
  /** @type {object[]} */
  const high = [];
  /** @type {object[]} */
  const overbooked = [];

  for (const row of rows) {
    const kind = classifySlotRow(row, rules);
    if (!kind) continue;

    const item = {
      ...row,
      year,
      utilPct:
        row.totalPlants > 0
          ? Math.round((row.bookedPlants / row.totalPlants) * 100)
          : 0,
    };

    if (kind === "overbooked" || kind === "full") {
      if (!shouldSkipAlert(slotDedupeKey("critical", row))) {
        overbooked.push(item);
      }
    } else if (kind === "low") {
      if (!shouldSkipAlert(slotDedupeKey("low", row))) {
        low.push(item);
      }
    } else if (kind === "high") {
      if (!shouldSkipAlert(slotDedupeKey("high", row))) {
        high.push(item);
      }
    }
  }

  low.sort((a, b) => a.availablePlants - b.availablePlants);
  overbooked.sort((a, b) => a.availablePlants - b.availablePlants);
  high.sort((a, b) => b.availablePlants - a.availablePlants);

  const max = rules.slotDigestMaxRows;
  const lowSlice = low.slice(0, max);
  const highSlice = high.slice(0, max);
  const overSlice = overbooked.slice(0, max);

  if (!lowSlice.length && !highSlice.length && !overSlice.length) {
    return { skipped: true, reason: "nothing_new", scanned: rows.length };
  }

  const delivery = await sendSlotAvailabilityDigest({
    low: lowSlice,
    high: highSlice,
    overbooked: overSlice,
    year,
    totalScanned: rows.length,
  });

  if (delivery?.delivered > 0) {
    for (const row of lowSlice) markAlertSent(slotDedupeKey("low", row));
    for (const row of highSlice) markAlertSent(slotDedupeKey("high", row));
    for (const row of overSlice) markAlertSent(slotDedupeKey("critical", row));
  }

  return {
    sent: true,
    low: lowSlice.length,
    high: highSlice.length,
    overbooked: overSlice.length,
    scanned: rows.length,
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
