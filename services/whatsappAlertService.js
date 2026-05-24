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
import { getWhatsAppClient, isWhatsAppReady } from "./whatsappClient.js";
import { normalizePhoneForWhitelist } from "../utils/agriLoadLinkSigner.js";
import Order from "../models/order.model.js";

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const buildOrderRef = (order = {}) =>
  String(
    order?.linkedNurseryOrderCode ||
      order?.linkedNurseryOrderId ||
      order?.orderNumber ||
      order?._id ||
      "—"
  ).trim();

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
    console.warn(
      `[WhatsApp Alert] getNumberId(${digits}) failed, using ${fallback}:`,
      err?.message || err
    );
  }

  return fallback;
}

/**
 * Sends a WhatsApp message to a single number.
 * Never throws — returns { ok, chatId, resolvedId?, error?, reason? }.
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

  const wa = getWhatsAppClient();
  if (!wa) {
    console.warn("[WhatsApp Alert] Client not started — skipping alert to", chatId);
    return { ok: false, chatId, reason: "no_client" };
  }

  try {
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
  } catch (err) {
    const error = err?.message || String(err);
    console.error(`[WhatsApp Alert] ❌ Failed to send to ${chatId}:`, error);
    return { ok: false, chatId, error };
  }
}

/**
 * Sends a message to ALL admin numbers defined in env.
 * Errors on individual sends are logged but do not abort the others.
 */
async function alertAdmins(message, context = "alert") {
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
    const deliveryDate = order?.deliveryDate
      ? new Date(order.deliveryDate).toLocaleDateString("en-IN")
      : "—";

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

/**
 * 🟡 Order Updated
 * @param {object} order         - updated order document (plain object)
 * @param {string} changedBy     - name of user who made changes
 * @param {Array}  editHistory   - array of { field, previousValue, newValue, notes }
 * @param {object} existingDoc   - original document before update (populated: farmer.name/village/taluka)
 */
export async function sendOrderEditedAlert(order, changedBy = "Unknown", editHistory = [], existingDoc = null) {
  try {
    const src = existingDoc || order;
    const farmerName = src?.farmer?.name || src?.orderFor?.name || order?.farmer?.name || "—";
    const village = src?.farmer?.village || src?.orderFor?.village || order?.orderFor?.village || "—";
    const taluka = src?.farmer?.taluka || src?.orderFor?.taluka || order?.orderFor?.taluka || "—";

    // Build human-readable change lines from tracked edit history
    const changeLines = editHistory
      .filter((e) => e?.field && (e.previousValue !== undefined || e.newValue !== undefined))
      .map((e) => {
        const label = FIELD_LABELS[e.field] || e.field;
        let prev = e.previousValue;
        let next = e.newValue;

        if (e.field === "deliveryDate" || e.field === "farmReadyDate" || e.field === "dispatchTargetDate") {
          prev = prev ? new Date(prev).toLocaleDateString("en-IN") : "—";
          next = next ? new Date(next).toLocaleDateString("en-IN") : "—";
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

/**
 * 💰 Payment Received
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

    const message = [
      "💰 *Payment Received*",
      `Customer: ${customer}`,
      `Amount: ₹${Number(amount).toLocaleString("en-IN")}`,
      `Mode: ${mode}`,
      `Order No: ${orderNo}`,
    ].join("\n");

    await alertAdmins(message);
  } catch (err) {
    console.error("[WhatsApp Alert] sendPaymentReceivedAlert error:", err?.message || err);
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
    let itemIndex = 0;

    const actorPhone = normalizePhoneForWhitelist(process.env.WHATSAPP_ADMIN_NUMBERS?.split(",")?.[0] || "");
    const rawBaseUrl = process.env.FRONTEND_URL || process.env.PUBLIC_ACTION_BASE_URL || process.env.API_BASE_URL || "";
    const baseUrl = (
      rawBaseUrl && !rawBaseUrl.includes("YOUR_DOMAIN")
        ? rawBaseUrl
        : "https://erp.rambiotechplants.com"
    ).trim().replace(/\/+$/, "");

    (Array.isArray(linkedOrders) ? linkedOrders : []).forEach((o) => {
      const orderRef = buildOrderRef(o);
      if (orderRef && orderRef !== "—") pendingOrderRefs.add(orderRef);
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
            `${itemIndex}. ऑर्डर ${orderRef} | *${product}*${subtypeStr} | Qty: *${qty > 0 ? qty : "—"}*`
          );
        });
      } else {
        itemIndex += 1;
        const product = String(o?.productName || "Agri Input").trim();
        const subtype = resolveSubtype(o) || "—";
        const qty = resolveAgriQty(o);
        const subtypeStr = subtype && subtype !== "—" ? ` | ${subtype}` : "";
        orderLines.push(
          `${itemIndex}. ऑर्डर ${orderRef} | *${product}*${subtypeStr} | Qty: *${qty > 0 ? qty : "—"}*`
        );
      }
    });

    // Single mark-loaded link covering all pending orders (direct API action — no login needed)
    const allOrderRefs = Array.from(pendingOrderRefs);
    const primaryRef = allOrderRefs[0] || "";
    const markLoadedUrl =
      baseUrl && primaryRef
        ? `${baseUrl}/api/v1/agri-load-link/mark-loaded?orderNumber=${encodeURIComponent(primaryRef)}&actorPhone=${encodeURIComponent(actorPhone)}`
        : "";

    const trimmedOrderLines = orderLines.slice(0, 10);
    const pendingLabel = allOrderRefs.length > 0 ? allOrderRefs.join(", ") : "—";
    const driverStr = String(driverName || "").trim() || "—";

    const messageLines = [
      "🚨 *Agri Load Pending*",
      `Orders: ${linkedCount} | Pending: ${pendingLabel}`,
      `Driver: ${driverStr} | Vehicle: ${vehicleStr}`,
      trimmedOrderLines.length ? "*Load items:*" : `Load: ${productStr}`,
      ...trimmedOrderLines,
    ];

    if (markLoadedUrl) {
      messageLines.push(`Mark Loaded: ${markLoadedUrl}`);
    }
    messageLines.push("After load, click link to mark LOADED.");

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
    const date = summary?.date || new Date().toLocaleDateString("en-IN");
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
