/**
 * WATI cancelled-order template:
 * - Auto-send when order → CANCELLED / TEMPORARY_CANCELLED
 * - "रद्द करा" → no action
 * - "ऑर्डर कन्फर्म आहे" / "पुन्हा बुक करा" → revive order to PENDING
 */

import mongoose from "mongoose";
import Order from "../models/order.model.js";
import PlantSlot from "../models/slots.model.js";
import DealerWallet from "../models/dealerWallet.js";
import { lookupFarmerByMobile } from "./whatsappOrderFarmer.service.js";
import { sendSessionTextMessage } from "./watiService.js";
import { updateSlot } from "../controllers/factory.controller.js";
import { formatSlotOfferLabel } from "./whatsappFarmReadySlot.service.js";
import {
  extractInboundMessage,
  extractInboundMessageId,
  normalizeWhatsAppNumberForWati,
} from "../utility/watiInboundPayload.js";
import { findOrderForCancelReviveReply } from "../utility/whatsappCancelOrderResolve.js";
import {
  sendOrderCancelledWhatsApp,
  buildOrderCancelledTemplateSummary,
} from "../utility/watiMessaging.js";

export const CANCEL_DISMISS_BTN = "रद्द करा";
export const CANCEL_REVIVE_BTN = "ऑर्डर कन्फर्म आहे";
export const CANCEL_REVIVE_BTN_ALT = "पुन्हा बुक करा";

const ACTIVITY_LOG_MAX = 200;
const REVIVABLE_STATUSES = new Set(["CANCELLED", "TEMPORARY_CANCELLED"]);

function normalizeInboundText(text) {
  return String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

export function isCancelReviveButtonMessage(text) {
  const t = normalizeInboundText(text);
  return (
    t === CANCEL_DISMISS_BTN ||
    t === CANCEL_REVIVE_BTN ||
    t === CANCEL_REVIVE_BTN_ALT
  );
}

export function isCancelReviveConfirmMessage(text) {
  const t = normalizeInboundText(text);
  return t === CANCEL_REVIVE_BTN || t === CANCEL_REVIVE_BTN_ALT;
}

async function appendCancelActivityLog(orderId, entry) {
  if (!orderId) return;
  const doc = {
    direction: entry.direction,
    text: String(entry.text ?? "").slice(0, 4000),
    whatsappMessageId: entry.whatsappMessageId || null,
    waId: entry.waId || null,
    action: entry.action || null,
    sessionStep: entry.sessionStep || null,
    ...(entry.meta != null ? { meta: entry.meta } : {}),
  };
  try {
    await Order.updateOne(
      { _id: orderId },
      {
        $push: {
          whatsappCancelActivityLog: {
            $each: [doc],
            $slice: -ACTIVITY_LOG_MAX,
          },
        },
      }
    );
  } catch (err) {
    console.error("[cancel-revive] activity log failed:", err?.message || err);
  }
}

async function logFarmerInbound(orderId, payload) {
  await appendCancelActivityLog(orderId, {
    direction: "inbound",
    ...payload,
    action: payload.action || "farmer_message",
  });
  try {
    const { recordFarmerReply } = await import("./orderWhatsappOutbound.service.js");
    await recordFarmerReply({
      orderId,
      text: payload.text,
      action: payload.action || "farmer_message",
      messageId: payload.whatsappMessageId || null,
    });
  } catch (err) {
    console.error("[cancel-revive] outbound reply log failed:", err?.message || err);
  }
}

async function sendWatiReply(waId, messageText, logContext = {}) {
  const digits = normalizeWhatsAppNumberForWati(waId);
  if (!digits) throw new Error("Invalid waId for WATI reply");
  const result = await sendSessionTextMessage({ whatsappNumber: digits, messageText });
  const { orderId, action } = logContext;
  if (orderId) {
    await appendCancelActivityLog(orderId, {
      direction: "outbound",
      text: messageText,
      waId,
      action: action || "bot_reply",
    });
  }
  return result;
}

async function getDeliverySlotLabel(bookingSlotId) {
  if (!bookingSlotId) return "—";
  const slotDoc = await PlantSlot.findOne(
    { "subtypeSlots.slots._id": bookingSlotId },
    { "subtypeSlots.slots.$": 1 }
  ).lean();
  const slot = slotDoc?.subtypeSlots?.[0]?.slots?.[0];
  if (!slot) return "—";
  return formatSlotOfferLabel(slot);
}

function orderPlantQty(order) {
  const base = Number(order.numberOfPlants) || 0;
  const extra = Number(order.additionalPlants) || 0;
  if (typeof order.totalPlants === "number") return order.totalPlants;
  return base + extra;
}

export async function storeCancelTemplateSendMeta(orderId, localMessageId) {
  if (!orderId) return;
  const set = { whatsappCancelSentAt: new Date() };
  if (localMessageId) set.whatsappCancelMessageKey = String(localMessageId);
  await Order.updateOne({ _id: orderId }, { $set: set }).catch(() => {});
  await appendCancelActivityLog(orderId, {
    direction: "outbound",
    text: buildOrderCancelledTemplateSummary(),
    whatsappMessageId: localMessageId ? String(localMessageId) : null,
    action: "template_sent",
  });
}

/**
 * Send cancel template for one order (farmer must have mobile).
 */
export async function sendOrderCancelledWhatsAppForOrder(order) {
  if (process.env.WATI_ORDER_CANCELLED_ENABLED === "false") {
    return { success: false, skipped: true, reason: "disabled" };
  }

  const orderDoc = await Order.findById(order._id || order.id)
    .populate("farmer", "name mobileNumber village")
    .populate("plantName", "name")
    .populate("plantSubtype", "name");

  if (!orderDoc) return { success: false, error: "order_not_found" };

  const status = String(orderDoc.orderStatus || "").toUpperCase();
  if (!REVIVABLE_STATUSES.has(status)) {
    return { success: false, error: "not_cancelled_status", orderStatus: status };
  }

  if (orderDoc.whatsappCancelSentAt) {
    return {
      success: false,
      alreadySent: true,
      whatsappCancelSentAt: orderDoc.whatsappCancelSentAt,
    };
  }

  const farmerDoc = orderDoc.farmer;
  if (!farmerDoc?.mobileNumber) {
    return { success: false, error: "no_farmer_mobile" };
  }

  await Order.ensurePublicOrderCode(orderDoc);
  if (orderDoc.isModified?.("publicOrderCode")) {
    await orderDoc.save();
  }

  const plantLabel = [orderDoc.plantName?.name, orderDoc.plantSubtype?.name]
    .filter(Boolean)
    .join(" - ");
  const qty = orderPlantQty(orderDoc);
  const deliverySlotLabel = await getDeliverySlotLabel(orderDoc.bookingSlot);

  const result = await sendOrderCancelledWhatsApp(farmerDoc, {
    publicOrderCode: orderDoc.publicOrderCode,
    orderId: orderDoc.orderId || orderDoc._id,
    plantName: plantLabel || orderDoc.plantName?.name || "Plants",
    numberOfPlants: qty,
    orderBookingDate: orderDoc.orderBookingDate || orderDoc.createdAt,
    deliverySlotLabel,
  });

  if (result.success) {
    await storeCancelTemplateSendMeta(
      orderDoc._id,
      result.data?.localMessageId || result.localMessageId
    );
  }

  return {
    ...result,
    orderId: String(orderDoc._id),
    publicOrderCode: orderDoc.publicOrderCode,
  };
}

async function reopenDealerWalletForOrder(order, session) {
  const raw = order.dealer || order.salesPerson;
  const dealerId =
    raw && typeof raw === "object" && raw._id != null ? raw._id : raw;
  if (!dealerId || !mongoose.Types.ObjectId.isValid(String(dealerId))) return;

  const plantId = order.plantName?._id || order.plantName;
  const n = order.numberOfPlants || 0;
  if (n <= 0) return;

  let dealerWallet = await DealerWallet.findOne({ dealer: dealerId }).session(session);
  if (!dealerWallet) {
    dealerWallet = new DealerWallet({ dealer: dealerId, entries: [] });
  }

  const entryIdx = dealerWallet.entries.findIndex(
    (e) =>
      e.plantType?.toString() === String(plantId) &&
      e.subType?.toString() === String(order.plantSubtype) &&
      e.bookingSlot?.toString() === String(order.bookingSlot)
  );

  if (order.dealerOrder) {
    if (entryIdx === -1) {
      dealerWallet.entries.push({
        plantType: plantId,
        subType: order.plantSubtype,
        bookingSlot: order.bookingSlot,
        quantity: n,
        bookedQuantity: 0,
        remainingQuantity: n,
      });
    } else {
      const entry = dealerWallet.entries[entryIdx];
      entry.quantity = (entry.quantity || 0) + n;
      entry.remainingQuantity = (entry.quantity || 0) - (entry.bookedQuantity || 0);
    }
  } else if (entryIdx !== -1) {
    const entry = dealerWallet.entries[entryIdx];
    entry.bookedQuantity = (entry.bookedQuantity || 0) + n;
    entry.remainingQuantity = (entry.quantity || 0) - entry.bookedQuantity;
  }

  dealerWallet.markModified("entries");
  await dealerWallet.save({ session });
}

/**
 * Revive cancelled order → PENDING after farmer confirms on WhatsApp.
 */
export async function reviveOrderViaWhatsappCancelReply(order, waId, messageId = "") {
  const fresh = await Order.findById(order._id || order.id)
    .populate("plantName", "name")
    .populate("farmer", "name mobileNumber");
  if (!fresh) throw new Error("Order not found");

  const prevStatus = String(fresh.orderStatus || "").toUpperCase();
  if (!REVIVABLE_STATUSES.has(prevStatus)) {
    return { handled: true, action: "not_revivable_status", orderStatus: prevStatus };
  }

  if (fresh.revivedViaFarmerWhatsappAt) {
    await sendWatiReply(
      waId,
      "ℹ️ ही ऑर्डर आधीच पुन्हा सक्रिय केली आहे. 📞 7218186452 वर संपर्क करा.",
      { orderId: fresh._id, action: "already_revived" }
    );
    return { handled: true, action: "already_revived" };
  }

  await logFarmerInbound(fresh._id, {
    text: CANCEL_REVIVE_BTN,
    waId,
    whatsappMessageId: messageId || null,
    action: "button_revive_confirm",
  });

  const session = await mongoose.startSession();
  try {
    let updated;
    await session.withTransaction(async () => {
      const locked = await Order.findById(fresh._id).session(session);
      if (!locked || !REVIVABLE_STATUSES.has(String(locked.orderStatus || "").toUpperCase())) {
        throw new Error("Order is no longer cancelled");
      }

      if (!locked.dealerOrder && locked.bookingSlot) {
        await updateSlot(locked.bookingSlot, locked.numberOfPlants, "subtract", session);
      }

      const isDealerQuotaOrder =
        locked.dealerOrder ||
        (locked.quotaSource === "dealer" && (locked.dealer || locked.salesPerson));
      if (isDealerQuotaOrder) {
        await reopenDealerWalletForOrder(locked, session);
      }

      const now = new Date();
      const note = messageId
        ? `Farmer revived cancelled order via WATI (${CANCEL_REVIVE_BTN}) [${messageId}]`
        : `Farmer revived cancelled order via WATI (${CANCEL_REVIVE_BTN})`;

      updated = await Order.findByIdAndUpdate(
        locked._id,
        {
          $set: {
            orderStatus: "PENDING",
            revivedViaFarmerWhatsappAt: now,
            revivedViaFarmerWhatsappFromStatus: prevStatus,
            revivedViaFarmerWhatsappMessageId: messageId || null,
            quotaRestored: false,
          },
          $push: {
            statusChanges: {
              previousStatus: prevStatus,
              newStatus: "PENDING",
              reason: "Farmer confirmed order via WATI after cancellation",
              notes: messageId || "",
              changedBy: null,
            },
            orderEditHistory: {
              field: "orderStatus",
              previousValue: prevStatus,
              newValue: "PENDING",
              changedBy: null,
              notes: note,
            },
          },
        },
        { new: true, runValidators: true, session }
      );
    });

    const orderCode = updated.publicOrderCode || updated.orderId || updated._id;
    await sendWatiReply(
      waId,
      [
        "✅ धन्यवाद!",
        "",
        "आपली ऑर्डर पुन्हा सक्रिय झाली.",
        `📦 ऑर्डर आयडी: ${orderCode}`,
        "📋 स्थिती: Pending",
        "",
        "आमचा प्रतिनिधी लवकरच संपर्क साधेल.",
        "📞 7218186452",
      ].join("\n"),
      { orderId: updated._id, action: "order_revived_reply" }
    );

    console.log(
      `[cancel-revive] Order ${orderCode}: ${prevStatus} → PENDING (farmer WhatsApp revive)`
    );

    return {
      handled: true,
      action: "order_revived",
      orderId: String(updated._id),
      previousStatus: prevStatus,
    };
  } catch (err) {
    console.error("[cancel-revive] revive failed:", err?.message || err);
    await sendWatiReply(
      waId,
      "⚠️ ऑर्डर पुन्हा सक्रिय करता आली नाही (कदाचित स्लॉट भरला). 📞 7218186452 वर संपर्क करा.",
      { orderId: fresh._id, action: "revive_failed" }
    );
    return { handled: true, action: "revive_failed", error: err?.message || String(err) };
  } finally {
    session.endSession();
  }
}

export async function runCancelReviveWebhookFromBody(body) {
  try {
    return await runCancelReviveWebhookFromBodyInner(body);
  } catch (err) {
    console.error("[cancel-revive] webhook error:", err?.message || err);
    return { handled: false, error: err?.message || String(err) };
  }
}

async function runCancelReviveWebhookFromBodyInner(body) {
  const { text, waId } = extractInboundMessage(body);
  const messageId = extractInboundMessageId(body);
  const inbound = normalizeInboundText(text);

  if (!waId || !inbound) {
    return { handled: false, reason: "no_waId_or_text" };
  }

  if (!isCancelReviveButtonMessage(inbound)) {
    return { handled: false, reason: "not_cancel_revive_button" };
  }

  const mobile10 =
    String(waId).replace(/\D/g, "").length === 12
      ? String(waId).replace(/\D/g, "").slice(2)
      : String(waId).replace(/\D/g, "").slice(-10);

  if (!mobile10 || mobile10.length !== 10) {
    return { handled: false, reason: "invalid_mobile" };
  }

  const farmer = await lookupFarmerByMobile(mobile10);
  if (!farmer?.id) {
    return { handled: true, action: "farmer_not_found" };
  }

  const order = await findOrderForCancelReviveReply({
    body,
    farmerId: farmer.id,
    inboundText: inbound,
  });

  if (!order) {
    return { handled: true, action: "order_not_found" };
  }

  if (inbound === CANCEL_DISMISS_BTN) {
    await logFarmerInbound(order._id, {
      text: inbound,
      waId,
      whatsappMessageId: messageId || null,
      action: "button_dismiss",
    });
    return { handled: true, action: "cancel_dismissed", orderId: String(order._id) };
  }

  return reviveOrderViaWhatsappCancelReply(order, waId, messageId);
}
