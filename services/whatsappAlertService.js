/**
 * WhatsApp Alert Service — internal ERP alerts only.
 *
 * Sends short WhatsApp messages to admin/team numbers when ERP events occur.
 * This is NOT a chatbot — no incoming message handling, no AI replies.
 *
 * Required env vars:
 *   WHATSAPP_ADMIN_NUMBERS=919876543210,919999999999
 *   WHATSAPP_ALERTS_ENABLED=true
 */

import mongoose from "mongoose";
import {
  getWhatsAppClient,
  isWhatsAppReady,
  isWhatsAppDetachedError,
  reportWhatsAppTransportFailure,
  waitUntilWhatsAppReady,
} from "./whatsappClient.js";
import { normalizePhoneForWhitelist } from "../utils/agriLoadLinkSigner.js";
import Order from "../models/order.model.js";
import { formatWatiDateEnIN } from "../utility/watiIstDateFormat.js";

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

import { buildAgriLoadConfirmPageUrl } from "./agriLoadLink.service.js";

const buildNurseryOrderRef = (order = {}) =>
  String(
    order?.linkedNurseryOrderCode ||
      order?.linkedNurseryOrderId ||
      order?.orderNumber ||
      order?._id ||
      "—"
  ).trim();

const buildAgriOrderNumber = (order = {}) =>
  String(order?.orderNumber || order?.agriOrderNumber || "").trim();

const resolveAgriQty = (order = {}) => {
  const directQty =
    toNumber(order?.quantity) ||
    toNumber(order?.deliveredQuantity) ||
    toNumber(order?.orderQuantity);
  if (directQty > 0) return directQty;

  const lineItems = Array.isArray(order?.lineItems) ? order.lineItems : [];
  const fromLines = lineItems.reduce(
    (sum, li) =>
      sum +
      (toNumber(li?.quantity) ||
        toNumber(li?.qty) ||
        toNumber(li?.requestedQuantity) ||
        0),
    0
  );
  return fromLines;
};

const resolveSubtype = (row = {}) =>
  String(
    row?.ramAgriVarietyName ||
      row?.varietyName ||
      row?.subtypeName ||
      row?.subtype ||
      row?.type ||
      ""
  ).trim();

/**
 * Converts a 10-digit number to WhatsApp ID format.
 * Handles: 9876543210 → 919876543210@c.us
 * Already-formatted numbers (ending in @c.us) are passed through unchanged.
 */
function formatNumber(number) {
  const str = String(number).trim();
  if (str.endsWith("@c.us")) return str;

  // Strip all non-digits
  const digits = str.replace(/\D/g, "");

  // If already has country code (12+ digits starting with 91), use as-is
  if (digits.length >= 12 && digits.startsWith("91")) {
    return `${digits}@c.us`;
  }

  // 10-digit Indian number — prepend country code
  if (digits.length === 10) {
    return `91${digits}@c.us`;
  }

  // Fallback: use whatever digits we have
  return `${digits}@c.us`;
}

/**
 * Returns all admin WhatsApp IDs from WHATSAPP_ADMIN_NUMBERS env var.
 * Skips empty entries and formats each number correctly.
 */
export function getAdminNumbersFromEnv() {
  const raw = process.env.WHATSAPP_ADMIN_NUMBERS || "";
  return raw
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
    .map(formatNumber);
}

/** Digits with country code for getNumberId (no @suffix). */
function digitsForWhatsAppLookup(number) {
  const raw = String(number).trim();
  const digits = (raw.includes("@") ? raw.split("@")[0] : raw).replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

/**
 * Resolve chat id via WhatsApp (required for many numbers not already in chat list).
 */
async function resolveWhatsAppChatId(wa, number) {
  const digits = digitsForWhatsAppLookup(number);
  const fallback = formatNumber(number);

  if (!digits || digits.length < 10) {
    return fallback;
  }

  try {
    const registered = await wa.getNumberId(digits);
    if (registered?._serialized) {
      return registered._serialized;
    }
  } catch (err) {
    // Dead Puppeteer page — don't pretend fallback send will work
    if (isWhatsAppDetachedError(err)) throw err;
    console.warn(
      `[WhatsApp Alert] getNumberId(${digits}) failed, using ${fallback}:`,
      err?.message || err
    );
  }

  return fallback;
}

async function sendWhatsAppMessageOnce(number, message) {
  const chatId = formatNumber(number);

  if (!isWhatsAppReady) {
    return { ok: false, chatId, reason: "not_ready" };
  }

  const wa = getWhatsAppClient();
  if (!wa) {
    return { ok: false, chatId, reason: "no_client" };
  }

  const targetId = await resolveWhatsAppChatId(wa, number);
  const sent = await wa.sendMessage(targetId, message);
  console.log(
    `[WhatsApp Alert] ✅ Sent to ${targetId}`,
    sent?.id?._serialized ? `(id ${sent.id._serialized})` : ""
  );
  return {
    ok: true,
    chatId,
    resolvedId: targetId,
    messageId: sent?.id?._serialized || null,
  };
}

/**
 * Sends a WhatsApp message to a single number.
 * Never throws — returns { ok, chatId, resolvedId?, error?, reason? }.
 * On detached Frame, re-inits client and retries once.
 */
export async function sendWhatsAppMessage(number, message) {
  const chatId = formatNumber(number);

  if (process.env.WHATSAPP_ALERTS_ENABLED !== "true") {
    return { ok: false, chatId, reason: "alerts_disabled" };
  }

  if (!isWhatsAppReady) {
    console.warn("[WhatsApp Alert] Client not ready — skipping alert to", chatId);
    return { ok: false, chatId, reason: "not_ready" };
  }

  try {
    return await sendWhatsAppMessageOnce(number, message);
  } catch (err) {
    const error = err?.message || String(err);
    if (reportWhatsAppTransportFailure(err, "alert-send")) {
      console.warn(
        `[WhatsApp Alert] Detached frame on ${chatId} — waiting for reinit then retry once`
      );
      const ready = await waitUntilWhatsAppReady(90000);
      if (ready) {
        try {
          return await sendWhatsAppMessageOnce(number, message);
        } catch (retryErr) {
          const retryError = retryErr?.message || String(retryErr);
          console.error(
            `[WhatsApp Alert] ❌ Retry failed to ${chatId}:`,
            retryError
          );
          reportWhatsAppTransportFailure(retryErr, "alert-retry");
          return { ok: false, chatId, error: retryError };
        }
      }
    }
    console.error(`[WhatsApp Alert] ❌ Failed to send to ${chatId}:`, error);
    return { ok: false, chatId, error };
  }
}

export async function alertAdmins(message, context = "alert") {
  if (process.env.WHATSAPP_ALERTS_ENABLED !== "true") {
    console.warn(`[WhatsApp Alert] ${context} skipped — WHATSAPP_ALERTS_ENABLED is not true`);
    return { delivered: 0, total: 0, results: [], reason: "alerts_disabled" };
  }
  if (!isWhatsAppReady) {
    console.warn(`[WhatsApp Alert] ${context} skipped — WhatsApp client not ready`);
    return { delivered: 0, total: 0, results: [], reason: "not_ready" };
  }

  const numbers = getAdminNumbersFromEnv();
  if (numbers.length === 0) {
    console.warn("[WhatsApp Alert] No admin numbers configured. Set WHATSAPP_ADMIN_NUMBERS.");
    return { delivered: 0, total: 0, results: [], reason: "no_admin_numbers" };
  }

  console.log(`[WhatsApp Alert] Sending ${context} to ${numbers.length} admin(s)...`);
  const results = await Promise.all(numbers.map((num) => sendWhatsAppMessage(num, message)));
  const delivered = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(
      `[WhatsApp Alert] ${context} failures:`,
      failed.map((f) => `${f.chatId}: ${f.error || f.reason}`).join("; ")
    );
  }
  console.log(`[WhatsApp Alert] ${context} done — ${delivered}/${numbers.length} delivered`);
  return { delivered, total: numbers.length, results };
}

/** Reload order with farmer/sales names after create transaction commits. */
async function loadOrderForWhatsAppAlert(orderOrId) {
  const orderId = orderOrId?._id || orderOrId;
  if (!orderId || !mongoose.isValidObjectId(String(orderId))) return null;
  return Order.findById(orderId)
    .populate("farmer", "name village taluka talukaName")
    .populate("salesPerson", "name")
    .lean();
}

// ---------------------------------------------------------------------------
// Named alert functions
// ---------------------------------------------------------------------------

/**
 * 🟢 New Order Placed
 */
export async function sendOrderPlacedAlert(orderOrId) {
  try {
    const order =
      (await loadOrderForWhatsAppAlert(orderOrId)) ||
      (orderOrId && typeof orderOrId === "object" ? orderOrId : null);

    if (!order) {
      console.warn("[WhatsApp Alert] sendOrderPlacedAlert — order not found:", orderOrId);
      return;
    }

    const farmerName =
      order?.farmer?.name || order?.orderFor?.name || "—";
    const salesPersonName = order?.salesPerson?.name || "—";
    const farmerVillage =
      order?.farmer?.village || order?.orderFor?.village || "—";
    const farmerTaluka =
      order?.farmer?.talukaName ||
      order?.farmer?.taluka ||
      order?.orderFor?.taluka ||
      order?.orderFor?.talukaName ||
      "—";

    const orderNo = order?.orderId || order?.publicOrderCode || order?._id || "—";
    const plants = Number(order?.numberOfPlants) || 0;
    const rate = Number(order?.rate) || 0;
    const amount =
      order?.totalAmount != null
        ? Number(order.totalAmount)
        : plants && rate
          ? plants * rate
          : rate || 0;
    const deliveryDate = formatWatiDateEnIN(order?.deliveryDate, "—");

    const message = [
      "🟢 *New Order Placed*",
      `Order No: ${orderNo}`,
      `Customer: ${farmerName}`,
      `Village: ${farmerVillage} | Taluka: ${farmerTaluka}`,
      `Amount: ₹${Number(amount).toLocaleString("en-IN")}`,
      `Plants: ${plants || "—"}`,
      `Delivery Date: ${deliveryDate}`,
      `Placed By: ${salesPersonName}`,
    ].join("\n");

    return await alertAdmins(message, `new order #${orderNo}`);
  } catch (err) {
    console.error("[WhatsApp Alert] sendOrderPlacedAlert error:", err?.message || err);
    return { delivered: 0, total: 0, results: [], error: err?.message || String(err) };
  }
}

/**
 * 🔥 Big order — quantity at or above WHATSAPP_ALERT_BIG_ORDER_QTY (default 10,000).
 */
export async function sendBigOrderAlert(order, { qty, threshold } = {}) {
  try {
    const plants = qty ?? orderPlantQtyFromDoc(order);
    const minQty = threshold ?? parseInt(process.env.WHATSAPP_ALERT_BIG_ORDER_QTY || "10000", 10);

    const farmerName =
      order?.farmer?.name || order?.orderFor?.name || "—";
    const salesPersonName = order?.salesPerson?.name || "—";
    const farmerVillage =
      order?.farmer?.village || order?.orderFor?.village || "—";
    const plantLabel =
      order?.plantName?.name ||
      (typeof order?.plantName === "string" ? order.plantName : null) ||
      "—";
    const orderNo = order?.orderId || order?.publicOrderCode || order?._id || "—";
    const rate = Number(order?.rate) || 0;
    const amount =
      order?.totalAmount != null
        ? Number(order.totalAmount)
        : plants && rate
          ? plants * rate
          : 0;
    const deliveryDate = formatWatiDateEnIN(order?.deliveryDate, "—");

    const message = [
      "🔥 *BIG ORDER ALERT*",
      `_Quantity ≥ ${minQty.toLocaleString("en-IN")} plants_`,
      "",
      `Order No: *${orderNo}*`,
      `Customer: ${farmerName}`,
      `Village: ${farmerVillage}`,
      `Plant: *${plantLabel}*`,
      `Plants: *${Number(plants).toLocaleString("en-IN")}*`,
      `Amount: ₹${Number(amount).toLocaleString("en-IN")}`,
      `Delivery: ${deliveryDate}`,
      `Sales: ${salesPersonName}`,
    ].join("\n");

    return await alertAdmins(message, `big order #${orderNo} (${plants})`);
  } catch (err) {
    console.error("[WhatsApp Alert] sendBigOrderAlert error:", err?.message || err);
    return { delivered: 0, total: 0, results: [], error: err?.message || String(err) };
  }
}

function orderPlantQtyFromDoc(order = {}) {
  const base = Number(order?.numberOfPlants) || 0;
  const extra = Number(order?.additionalPlants) || 0;
  const total = Number(order?.totalPlants);
  if (total > 0) return total;
  return base + extra;
}

function formatSlotLine(row) {
  const window = `${row.startDay}–${row.endDay}`;
  const month = row.month ? ` (${row.month})` : "";
  return `• *${row.plantName}* / ${row.subtypeName} — ${window}${month}\n  Avail: *${row.availablePlants}* / ${row.totalPlants} (booked ${row.bookedPlants}, ${row.utilPct ?? 0}% full)`;
}

/**
 * 📦 Slot availability digest — low, high, overbooked (from alert engine scan).
 */
export async function sendSlotAvailabilityDigest({
  low = [],
  high = [],
  overbooked = [],
  year,
  totalScanned = 0,
}) {
  try {
    const lines = [
      "📦 *Slot availability alerts*",
      `_Scanned ${totalScanned} active slots · year ${year}_`,
      "",
    ];

    if (overbooked.length) {
      lines.push("⚠️ *Overbooked / critical*");
      for (const row of overbooked) {
        lines.push(formatSlotLine(row));
      }
      lines.push("");
    }

    if (low.length) {
      lines.push("🔴 *Low availability* (almost full)");
      for (const row of low) {
        lines.push(formatSlotLine(row));
      }
      lines.push("");
    }

    if (high.length) {
      lines.push("🟢 *High availability* (open capacity — push sales)");
      for (const row of high) {
        lines.push(formatSlotLine(row));
      }
      lines.push("");
    }

    if (lines.length <= 3) {
      return { delivered: 0, total: 0, results: [], reason: "empty_digest" };
    }

    return await alertAdmins(lines.join("\n").trimEnd(), "slot availability digest");
  } catch (err) {
    console.error("[WhatsApp Alert] sendSlotAvailabilityDigest error:", err?.message || err);
    return { delivered: 0, total: 0, results: [], error: err?.message || String(err) };
  }
}

/**
 * 🚨 Operational backlog digest (stuck orders, payments, overflow slots).
 */
export async function sendOpsAlertsDigest({ text, counts }) {
  try {
    const message = [
      "🚨 *Daily ops alert*",
      "_Automated engine scan_",
      "",
      text,
      "",
      `_Counts: ACCEPTED>7d ${counts?.stuckAccepted ?? 0} | FARM_READY stale ${counts?.stuckFarmReady ?? 0} | payment pending ${counts?.paymentPending ?? 0} | PENDING>7d ${counts?.oldPendingNew ?? 0} | over-cap slots ${counts?.overflowSlots ?? 0}_`,
    ].join("\n");

    return await alertAdmins(message, "ops digest");
  } catch (err) {
    console.error("[WhatsApp Alert] sendOpsAlertsDigest error:", err?.message || err);
    return { delivered: 0, total: 0, results: [], error: err?.message || String(err) };
  }
}

const FIELD_LABELS = {
  orderStatus: "Status",
  numberOfPlants: "Qty",
  rate: "Rate",
  deliveryDate: "Delivery Date",
  bookingSlot: "Booking Slot",
  salesPerson: "Sales Person",
  plantSubtype: "Subtype",
  orderPaymentStatus: "Payment Status",
  notes: "Notes",
  farmReadyDate: "Farm Ready Date",
  dispatchDayKey: "Dispatch Day",
  dispatchTargetDate: "Dispatch Target",
  cavity: "Tray",
  expectedNursery: "Nursery",
  batchNumber: "Batch",
  freightCharges: "Freight (₹)",
  deliveryChallanInvoiceNumber: "Invoice No",
  remainingPlants: "Remaining Qty",
  returnedPlants: "Returned Qty",
  damagedPlants: "Damaged Qty",
  additionalPlants: "Additional Qty",
  orderFor: "Order For",
};

/** Only qty/rate edits trigger admin WhatsApp — not dispatch status, nursery, remaining qty, etc. */
export const WHATSAPP_ORDER_EDIT_ALERT_FIELDS = new Set([
  "numberOfPlants",
  "rate",
  "additionalPlants",
]);

export function filterEditHistoryForWhatsAppAlert(editHistory = []) {
  return (Array.isArray(editHistory) ? editHistory : []).filter(
    (e) => e?.field && WHATSAPP_ORDER_EDIT_ALERT_FIELDS.has(e.field)
  );
}

/**
 * 🟡 Order Updated — qty / rate edits only (dispatch status changes are silent).
 * @param {object} order         - updated order document (plain object)
 * @param {string} changedBy     - name of user who made changes
 * @param {Array}  editHistory   - array of { field, previousValue, newValue, notes }
 * @param {object} existingDoc   - original document before update (populated: farmer.name/village/taluka)
 */
export async function sendOrderEditedAlert(order, changedBy = "Unknown", editHistory = [], existingDoc = null) {
  try {
    const alertableHistory = filterEditHistoryForWhatsAppAlert(editHistory);
    if (alertableHistory.length === 0) {
      return;
    }

    const src = existingDoc || order;
    const farmerName = src?.farmer?.name || src?.orderFor?.name || order?.farmer?.name || "—";
    const village = src?.farmer?.village || src?.orderFor?.village || order?.orderFor?.village || "—";
    const taluka = src?.farmer?.taluka || src?.orderFor?.taluka || order?.orderFor?.taluka || "—";

    // Build human-readable change lines from tracked edit history
    const changeLines = alertableHistory
      .filter((e) => e?.field && (e.previousValue !== undefined || e.newValue !== undefined))
      .map((e) => {
        const label = FIELD_LABELS[e.field] || e.field;
        let prev = e.previousValue;
        let next = e.newValue;

        if (e.field === "deliveryDate" || e.field === "farmReadyDate" || e.field === "dispatchTargetDate") {
          prev = formatWatiDateEnIN(prev, "—");
          next = formatWatiDateEnIN(next, "—");
        }
        if (e.field === "orderStatus") {
          prev = String(prev ?? "—").replace(/_/g, " ");
          next = String(next ?? "—").replace(/_/g, " ");
        }
        if (e.notes && e.field === "orderStatus") {
          return `  • ${label}: ${prev} → ${next} (${e.notes})`;
        }

        if (prev !== undefined && next !== undefined) {
          return `  • ${label}: ${prev} → ${next}`;
        }
        return `  • ${label} updated`;
      });

    if (changeLines.length === 0) {
      return;
    }

    const orderNo =
      order?.orderId || order?.orderNumber || existingDoc?.orderId || "—";

    const message = [
      "🟡 *Order Updated*",
      `Order #: ${orderNo}`,
      `Farmer: ${farmerName}`,
      `Village: ${village} | Taluka: ${taluka}`,
      `Updated By: ${changedBy}`,
      "Changes:",
      ...changeLines,
    ].join("\n");

    await alertAdmins(message);
  } catch (err) {
    console.error("[WhatsApp Alert] sendOrderEditedAlert error:", err?.message || err);
  }
}

/**
 * 🚚 Order status moved to DISPATCHED (Marathi)
 */
export async function sendOrderDispatchedAlert(order, changedBy = "Unknown") {
  try {
    const orderNo = order?.orderNumber || order?.orderId || order?._id || "—";
    const customer =
      order?.farmer?.name || order?.orderFor?.name || order?.salesPerson?.name || "—";
    const qty = order?.numberOfPlants ?? order?.quantity ?? "—";

    const message = [
      "🚚 *ऑर्डर डिस्पॅच झाली*",
      `ऑर्डर नंबर: ${orderNo}`,
      `ग्राहक: ${customer}`,
      `प्रमाण: ${qty}`,
      `स्टेटस: DISPATCHED`,
      `अपडेट केले: ${changedBy}`,
    ].join("\n");

    await alertAdmins(message);
  } catch (err) {
    console.error("[WhatsApp Alert] sendOrderDispatchedAlert error:", err?.message || err);
  }
}

function formatWatiFarmerMessageStatus(wati = {}) {
  if (wati.skipped) {
    return `⏭️ Skipped (${wati.reason || "—"})`;
  }
  if (wati.success === false) {
    const err =
      typeof wati.error === "string"
        ? wati.error
        : wati.error?.message || wati.error?.info || "send failed";
    return `❌ Failed — ${String(err).slice(0, 120)}`;
  }
  if (wati.success) {
    const st = String(wati.outboundStatus || wati.status || "sent").toLowerCase();
    const labels = {
      sent: "✅ Sent",
      delivered: "✅ Delivered",
      read: "✅ Read",
      pending: "⏳ Pending",
      failed: "❌ Failed",
    };
    return labels[st] || `✅ ${st}`;
  }
  return "—";
}

/**
 * 💰 Payment Received — admin alert with receipt links + farmer WATI status.
 */
export async function sendPaymentReceivedAlert(payment) {
  try {
    const customer =
      payment?.farmer?.name ||
      payment?.customerName ||
      payment?.order?.farmer?.name ||
      "—";
    const amount = payment?.paidAmount ?? payment?.amount ?? "—";
    const mode = payment?.modeOfPayment || payment?.mode || "—";
    const orderNo =
      payment?.orderNumber || payment?.order?.orderNumber || payment?.order?._id || "—";
    const payStatus = payment?.paymentStatus || "COLLECTED";
    const attachmentUrls = Array.isArray(payment?.attachmentUrls)
      ? payment.attachmentUrls.filter(Boolean)
      : [];

    const lines = [
      "💰 *Payment Received*",
      `Customer: ${customer}`,
      `Amount: ₹${Number(amount).toLocaleString("en-IN")}`,
      `Mode: ${mode}`,
      `Payment status: *${payStatus}*`,
      `Order No: ${orderNo}`,
      `Farmer WATI msg: ${formatWatiFarmerMessageStatus(payment?.wati || {})}`,
    ];

    if (attachmentUrls.length) {
      lines.push("");
      lines.push("*Receipt / attachment:*");
      attachmentUrls.slice(0, 3).forEach((url, i) => {
        lines.push(`📎 ${attachmentUrls.length > 1 ? `${i + 1}. ` : ""}${url}`);
      });
      if (attachmentUrls.length > 3) {
        lines.push(`_+${attachmentUrls.length - 3} more in ERP_`);
      }
    }

    await alertAdmins(lines.join("\n"), "payment received");
  } catch (err) {
    console.error("[WhatsApp Alert] sendPaymentReceivedAlert error:", err?.message || err);
  }
}

/**
 * 📦 Stock change alerts — inward, outward, direct, closing, adjustment
 * @param {object} params
 * @param {"inward"|"outward"|"direct"|"closing"|"adjustment"} [params.changeType]
 */
export async function sendStockChangeAlert({
  changeType = "inward",
  productName,
  quantity,
  unit,
  referenceNumber,
  supplierName,
  oldStock,
  newStock,
  performedByName,
  source,
  notes,
  stockDate,
  closingStock,
  systemStock,
  adjustmentType,
  reason,
} = {}) {
  try {
    const qty = Number(quantity);
    const qtyLabel = Number.isFinite(qty)
      ? qty.toLocaleString("en-IN")
      : String(quantity ?? "—");
    const fmt = (n) =>
      n != null && Number.isFinite(Number(n))
        ? Number(n).toLocaleString("en-IN")
        : null;

    let title = "📦 *Stock Inward*";
    const lines = [`Product: ${productName || "—"}`];

    switch (changeType) {
      case "outward":
        title = "📤 *Stock Outward*";
        lines.push(`Removed: −${qtyLabel}${unit ? ` ${unit}` : ""}`);
        break;
      case "direct":
        title = "🔄 *Direct Stock Update*";
        if (oldStock != null && newStock != null) {
          lines.push(`Previous: ${fmt(oldStock)} → New: ${fmt(newStock)}`);
          const delta = Number(newStock) - Number(oldStock);
          if (Number.isFinite(delta) && delta !== 0) {
            lines.push(`Change: ${delta > 0 ? "+" : ""}${delta.toLocaleString("en-IN")}${unit ? ` ${unit}` : ""}`);
          }
        } else if (newStock != null) {
          lines.push(`New stock: ${fmt(newStock)}${unit ? ` ${unit}` : ""}`);
        }
        break;
      case "closing":
        title = "📋 *Daily Closing Stock*";
        if (stockDate) lines.unshift(`Date: ${stockDate}`);
        if (closingStock != null) {
          lines.push(`Closing count: ${fmt(closingStock)}${unit ? ` ${unit}` : ""}`);
        }
        if (systemStock != null) {
          lines.push(`System stock: ${fmt(systemStock)}${unit ? ` ${unit}` : ""}`);
        }
        if (
          closingStock != null &&
          systemStock != null &&
          Number(closingStock) !== Number(systemStock)
        ) {
          const diff = Number(closingStock) - Number(systemStock);
          lines.push(
            `Variance: ${diff > 0 ? "+" : ""}${diff.toLocaleString("en-IN")}${unit ? ` ${unit}` : ""}`
          );
        }
        break;
      case "adjustment":
        title = "⚖️ *Stock Adjustment*";
        lines.push(`Type: ${adjustmentType || "—"}`);
        if (Number.isFinite(qty) && qty !== 0) {
          lines.push(
            `Change: ${qty > 0 ? "+" : ""}${qtyLabel}${unit ? ` ${unit}` : ""}`
          );
        }
        if (reason) lines.push(`Reason: ${reason}`);
        break;
      default:
        lines.push(`Added: +${qtyLabel}${unit ? ` ${unit}` : ""}`);
    }

    if (referenceNumber && changeType !== "closing") {
      lines.push(`Ref: ${referenceNumber}`);
    }
    if (supplierName) lines.push(`Supplier: ${supplierName}`);
    if (newStock != null && changeType !== "direct" && changeType !== "closing") {
      lines.push(`Current stock: ${fmt(newStock)}${unit ? ` ${unit}` : ""}`);
    }
    if (notes) lines.push(`Notes: ${notes}`);
    if (performedByName) lines.push(`Updated by: ${performedByName}`);
    if (source) lines.push(`Via: ${source}`);

    const message = [title, ...lines].join("\n");
    const ctx = `${changeType} stock ${referenceNumber || productName || stockDate || ""}`.trim();
    return await alertAdmins(message, ctx);
  } catch (err) {
    console.error("[WhatsApp Alert] sendStockChangeAlert error:", err?.message || err);
    return { delivered: 0, total: 0, results: [], error: err?.message || String(err) };
  }
}

/**
 * 📦 Stock inward / purchase GRN — admin alert (alias)
 */
export async function sendStockInwardAlert(params = {}) {
  return sendStockChangeAlert({ ...params, changeType: "inward" });
}

/**
 * 📋 Bulk daily closing stock summary
 */
export async function sendDailyClosingStockSummaryAlert({
  stockDate,
  entries = [],
  performedByName,
} = {}) {
  try {
    if (!entries.length) return { delivered: 0, total: 0, results: [] };

    const lines = entries.slice(0, 20).map((e) => {
      const name = [e.cropName, e.varietyName].filter(Boolean).join(" - ") || "—";
      const closing = Number(e.closingStock);
      const system = Number(e.systemStock);
      const unit = e.unit ? ` ${e.unit}` : "";
      let line = `• ${name}: closing ${closing.toLocaleString("en-IN")}${unit}`;
      if (Number.isFinite(system) && closing !== system) {
        const diff = closing - system;
        line += ` (system ${system.toLocaleString("en-IN")}, ${diff > 0 ? "+" : ""}${diff.toLocaleString("en-IN")})`;
      }
      return line;
    });

    if (entries.length > 20) {
      lines.push(`… and ${entries.length - 20} more varieties`);
    }

    const message = [
      "📋 *Daily Closing Stock Saved*",
      `Date: ${stockDate || "—"}`,
      `Varieties: ${entries.length}`,
      "",
      ...lines,
      performedByName ? `\nSaved by: ${performedByName}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    return await alertAdmins(message, `closing stock ${stockDate}`);
  } catch (err) {
    console.error("[WhatsApp Alert] sendDailyClosingStockSummaryAlert error:", err?.message || err);
    return { delivered: 0, total: 0, results: [], error: err?.message || String(err) };
  }
}

/**
 * 🔴 Low Stock Alert
 */
export async function sendLowStockAlert(product) {
  try {
    const name = product?.name || product?.productName || "—";
    const available = product?.availableQty ?? product?.available ?? product?.stock ?? "—";
    const minimum = product?.minimumRequired ?? product?.minQty ?? "—";

    const message = [
      "🔴 *Low Stock Alert*",
      `Product: ${name}`,
      `Available Qty: ${available}`,
      `Minimum Required: ${minimum}`,
    ].join("\n");

    await alertAdmins(message);
  } catch (err) {
    console.error("[WhatsApp Alert] sendLowStockAlert error:", err?.message || err);
  }
}

/**
 * 🚚 Dispatch Created / In Process
 * @param {object} data
 * @param {string}   data.transportId
 * @param {string}   data.vehicleName
 * @param {string}   data.vehicleNumber
 * @param {string}   data.driverName
 * @param {string}   data.driverMobile
 * @param {string[]} data.farmerNames   - resolved farmer / customer names for the orders
 * @param {number}   data.totalPlants
 * @param {number}   data.orderCount
 * @param {boolean}  data.hasLinkedAgri - true when linked Agri inputs are pending manual load
 */
export async function sendDispatchAlert(data = {}) {
  try {
    const {
      transportId,
      vehicleName,
      vehicleNumber,
      driverName,
      driverMobile,
      farmerNames = [],
      totalPlants,
      orderCount,
      hasLinkedAgri = false,
    } = data;

    const vehicleStr = [vehicleName, vehicleNumber].filter(Boolean).join(" — ") || "—";
    const driverStr = [driverName, driverMobile ? `(${driverMobile})` : ""]
      .filter(Boolean)
      .join(" ") || "—";
    const farmersStr = farmerNames.length > 0 ? farmerNames.join(", ") : "—";

    const lines = [
      "🚚 *Dispatch*",
      `#${transportId || "—"} | Orders: ${orderCount ?? "—"} | Plants: ${totalPlants ?? "—"}`,
      `Driver: ${driverStr}`,
      `Vehicle: ${vehicleStr}`,
    ];

    if (hasLinkedAgri) {
      lines.push("📦 Linked agri pending (link in next msg)");
    }

    await alertAdmins(lines.join("\n"));
  } catch (err) {
    console.error("[WhatsApp Alert] sendDispatchAlert error:", err?.message || err);
  }
}

/**
 * 📦 Ram Agri Input Order — pending load alert with one-click mark-loaded link
 * @param {object} data
 * @param {number}   data.linkedCount    - number of linked agri orders still pending load
 * @param {string[]} data.products       - product names from linked agri orders
 * @param {string}   data.vehicleName
 * @param {string}   data.vehicleNumber
 * @param {string}   data.loadedBy       - name of the user who triggered the dispatch
 */
export async function sendLinkedAgriAlert(data = {}) {
  try {
    const {
      linkedCount = 0,
      products = [],
      linkedOrders = [],
      vehicleName,
      vehicleNumber,
      driverName = "",
      loadedBy = "System",
    } = data;

    const vehicleStr = [vehicleName, vehicleNumber].filter(Boolean).join(" — ") || "—";
    const productStr = products.length > 0 ? products.join(", ") : "—";
    const orderLines = [];
    const pendingOrderRefs = new Set();
    const agriOrderNumbers = [];
    let itemIndex = 0;

    const actorPhone = normalizePhoneForWhitelist(process.env.WHATSAPP_ADMIN_NUMBERS?.split(",")?.[0] || "");

    (Array.isArray(linkedOrders) ? linkedOrders : []).forEach((o) => {
      const nurseryRef = buildNurseryOrderRef(o);
      const agriNo = buildAgriOrderNumber(o);
      if (nurseryRef && nurseryRef !== "—") pendingOrderRefs.add(nurseryRef);
      if (agriNo) agriOrderNumbers.push(agriNo);
      const lineItems = Array.isArray(o?.lineItems) ? o.lineItems : [];

      if (lineItems.length > 0) {
        lineItems.forEach((li) => {
          itemIndex += 1;
          const product =
            String(li?.name || li?.productName || o?.productName || "Agri Input").trim();
          const subtype = resolveSubtype(li) || resolveSubtype(o) || "—";
          const qty =
            toNumber(li?.quantity) ||
            toNumber(li?.qty) ||
            toNumber(li?.requestedQuantity) ||
            0;
          const subtypeStr = subtype && subtype !== "—" ? ` | ${subtype}` : "";
          orderLines.push(
            `${itemIndex}. Nursery #${nurseryRef} | Agri ${agriNo || "—"} | *${product}*${subtypeStr} | Qty: *${qty > 0 ? qty : "—"}*`
          );
        });
      } else {
        itemIndex += 1;
        const product = String(o?.productName || "Agri Input").trim();
        const subtype = resolveSubtype(o) || "—";
        const qty = resolveAgriQty(o);
        const subtypeStr = subtype && subtype !== "—" ? ` | ${subtype}` : "";
        orderLines.push(
          `${itemIndex}. Nursery #${nurseryRef} | Agri ${agriNo || "—"} | *${product}*${subtypeStr} | Qty: *${qty > 0 ? qty : "—"}*`
        );
      }
    });

    const allNurseryRefs = Array.from(pendingOrderRefs);
    const primaryRef = allNurseryRefs[0] || agriOrderNumbers[0] || "";
    const confirmPageUrl =
      primaryRef && actorPhone
        ? buildAgriLoadConfirmPageUrl({
            orderRef: primaryRef,
            actorPhone,
            agriOrderNumbers: [...new Set(agriOrderNumbers.filter(Boolean))],
          })
        : "";

    const trimmedOrderLines = orderLines.slice(0, 10);
    const pendingLabel = allNurseryRefs.length > 0 ? allNurseryRefs.join(", ") : "—";
    const driverStr = String(driverName || "").trim() || "—";

    const messageLines = [
      "🚨 *Agri Load Pending*",
      `Orders: ${linkedCount} | Nursery: ${pendingLabel}`,
      `Driver: ${driverStr} | Vehicle: ${vehicleStr}`,
      trimmedOrderLines.length ? "*Load items:*" : `Load: ${productStr}`,
      ...trimmedOrderLines,
    ];

    if (confirmPageUrl) {
      messageLines.push(`Confirm load (Yes/No): ${confirmPageUrl}`);
    }
    messageLines.push("Open link → tap *YES* after agri products are loaded on vehicle.");

    const message = messageLines.filter(Boolean).join("\n");

    await alertAdmins(message);
  } catch (err) {
    console.error("[WhatsApp Alert] sendLinkedAgriAlert error:", err?.message || err);
  }
}

/**
 * 📊 Daily Summary Alert
 * @param {object} summary - { orderCount, totalRevenue, dispatches, date }
 */
export async function sendDailySummaryAlert(summary) {
  try {
    const date = summary?.date || formatWatiDateEnIN(new Date(), "—");
    const orders = summary?.orderCount ?? 0;
    const revenue = summary?.totalRevenue ?? 0;
    const dispatches = summary?.dispatches ?? 0;

    const message = [
      "📊 *Daily ERP Summary*",
      `Date: ${date}`,
      `New Orders: ${orders}`,
      `Total Revenue: ₹${Number(revenue).toLocaleString("en-IN")}`,
      `Dispatches: ${dispatches}`,
    ].join("\n");

    await alertAdmins(message);
  } catch (err) {
    console.error("[WhatsApp Alert] sendDailySummaryAlert error:", err?.message || err);
  }
}
