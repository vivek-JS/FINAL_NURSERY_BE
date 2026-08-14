import catchAsync from "../utility/catchAsync.js";
import Farmer from "../models/farmer.model.js";
import FarmerLead from "../models/farmerLead.model.js";
import { runFarmReadyWebhookFromBody } from "../services/whatsappFarmReadyReschedule.service.js";
import { runCancelReviveWebhookFromBody } from "../services/whatsappOrderCancelRevive.service.js";
import { runWhatsappReportWizardFromWebhookBody } from "../services/whatsappReportWizard.service.js";
import { runTodayBookingPdfJob } from "../services/bookingReportWebhook.service.js";
import {
  shouldUpdateFarmReadyOutboundStatus,
  updateOutboundFromStatusWebhook,
} from "../services/orderWhatsappOutbound.service.js";
import {
  extractInboundMessage,
} from "../utility/watiInboundPayload.js";
import { recordBroadcastContactReply } from "../services/whatsappBroadcastReply.service.js";
import {
  classifyWatiStatusEvent,
  updateBroadcastContactStatus,
} from "../services/whatsappBroadcastStatus.service.js";

const WATI_STATUS_DEBUG =
  process.env.WATI_STATUS_WEBHOOK_DEBUG !== "false";

function statusLog(...args) {
  if (WATI_STATUS_DEBUG) console.log("[WATI STATUS]", ...args);
}

async function applyOutboundStatusUpdate(params) {
  const result = await updateOutboundFromStatusWebhook(params).catch(() => ({ matched: 0 }));
  statusLog("outbound log update", {
    event: params.event,
    matched: result.matched,
    updated: result.updated,
    outboundId: result.id || null,
    localMessageId: params.localMessageId || null,
    watiWebhookId: params.watiWebhookId || null,
    whatsappMessageId: params.whatsappMessageId || null,
  });
  return result;
}

function safeJsonPreview(obj, max = 2000) {
  try {
    const s = JSON.stringify(obj);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(obj);
  }
}

/** WATI "Message Received" + legacy inbound event names (single-webhook setup). */
const INBOUND_EVENT_TYPES = new Set([
  "message",
  "message_received",
  "messagereceived",
  "messages",
  "button",
  "interactive",
]);

/** Template / delivery lifecycle — never treat as farmer inbound even if `text` is present. */
const OUTBOUND_STATUS_EVENT_TYPES = new Set([
  "templatemessagesent_v2",
  "templatemessagefailed",
  "sentmessagedelivered",
  "sentmessagedelivered_v2",
  "sentmessageread",
  "sentmessageread_v2",
  "sentmessagereplied_v2",
]);

function isOutboundStatusEvent(eventType) {
  return OUTBOUND_STATUS_EVENT_TYPES.has(String(eventType || "").toLowerCase());
}

function isInboundMessageEvent(body, eventType) {
  if (isOutboundStatusEvent(eventType)) return false;
  const et = String(eventType || "").toLowerCase();
  if (INBOUND_EVENT_TYPES.has(et)) return true;
  if (String(body?.statusString || "").toLowerCase() === "received") return true;
  if (body?.buttonText || body?.buttonReply?.text || body?.data?.buttonText) return true;
  const inbound = extractInboundMessage(body);
  if (inbound.waId && inbound.text?.trim()) return true;
  return false;
}

const MESSAGE_EVENT_TYPES = INBOUND_EVENT_TYPES;
// Normalize phone helper (expects 10-digit or 91-prefixed)
function normalizeWaId(waId) {
  if (!waId) return null;
  const s = String(waId).replace(/\D/g, "");
  if (s.length === 12 && s.startsWith("91")) return s.substring(2);
  if (s.length === 10) return s;
  if (s.length === 11 && s.startsWith("0")) return s.slice(1);
  return s;
}

// Parse WATI timestamp (ISO string or Unix seconds)
function parseTimestamp(ts) {
  if (!ts) return new Date();
  const n = parseInt(ts, 10);
  if (!isNaN(n) && n < 1e12) return new Date(n * 1000); // Unix seconds
  return new Date(ts);
}

export const handleWatiStatusWebhook = catchAsync(async (req, res) => {
  // Unified WATI webhook: template status (sent/delivered/read/failed) + Message Received.
  // Inbound → cancel-revive → farm-ready → report wizard (no WhatsApp order bot on this URL).

  const userAgent = req.headers["user-agent"] || "";
  const isWati = userAgent.toLowerCase().includes("wati");
  const body = req.body || {};

  statusLog("POST /api/v1/whatsapp-status/webhook", {
    isWati,
    bodyKeys: Object.keys(body),
    preview: safeJsonPreview(body),
  });

  const eventType = body.eventType || body.event;
  const messageType = body.type || body.data?.type || null;
  const watiWebhookId = body.id || body.data?.id || null;
  const localMessageId =
    body.localMessageId || body.data?.localMessageId || watiWebhookId || null;
  const waId = body.waId || body.whatsappId || body.data?.waId || body.data?.from || null;
  const statusString = body.statusString || body.status || null;
  const whatsappMessageId =
    body.whatsappMessageId || body.data?.whatsappMessageId || body.messageId || null;
  const timestampRaw =
    body.timestamp || body.created || body.data?.timestamp || new Date().toISOString();
  const failedCode = body.failedCode || body.data?.failedCode || null;
  const failedDetail = body.failedDetail || body.data?.failedDetail || null;
  const broadcastName =
    body.broadcastName || body.broadcast_name || body.data?.broadcastName || body.data?.broadcast_name || null;

  const normalizedPhone = normalizeWaId(waId);
  const inbound = extractInboundMessage(body);

  statusLog("parsed", {
    eventType: eventType || "(none)",
    statusString: statusString || "(none)",
    waId: waId || "(none)",
    localMessageId: localMessageId || "(none)",
    watiWebhookId: watiWebhookId || "(none)",
    whatsappMessageId: whatsappMessageId || "(none)",
    messageType: messageType || "(none)",
    inboundText: inbound.text ? String(inbound.text).slice(0, 120) : "(empty)",
    buttonText: inbound.buttonText || "(none)",
  });

  // Message Received / button replies (single WATI webhook with template status events)
  if (isInboundMessageEvent(body, eventType)) {
    statusLog("inbound message — cancel-revive → farm-ready → report wizard");
    res.status(200).json({
      success: true,
      message: "Unified webhook: processing inbound message async",
    });
    void (async () => {
      try {
        const cancelRevive = await runCancelReviveWebhookFromBody(body);
        if (cancelRevive.handled) {
          statusLog("cancel-revive forward result:", cancelRevive);
          return;
        }
        const farmReady = await runFarmReadyWebhookFromBody(body);
        if (farmReady.handled) {
          statusLog("farm-ready forward result:", farmReady);
          return;
        }
        const wizard = await runWhatsappReportWizardFromWebhookBody(body);
        if (wizard.handled) {
          statusLog("report wizard forward result:", wizard);
          return;
        }
        if (inbound.text?.trim() && (inbound.waId || normalizedPhone)) {
          await recordBroadcastContactReply({
            phone: inbound.waId || normalizedPhone,
            replyText: inbound.text,
            repliedAt: parseTimestamp(timestampRaw),
          });
        }
        if (process.env.WHATSAPP_LEGACY_INSTANT_BOOKING_PDF === "true") {
          void runTodayBookingPdfJob(body).catch((err) => {
            console.error("[WATI STATUS] legacy booking PDF:", err?.message || err);
          });
        }
      } catch (err) {
        console.error("[WATI STATUS] inbound forward error:", err?.message || err);
      }
    })();
    return;
  }

  // Always respond 200 to WATI for delivery status events
  try {
    if (!eventType) {
      statusLog("skip: no eventType");
      return res.status(200).json({ success: false, message: "No eventType" });
    }

    if (MESSAGE_EVENT_TYPES.has(String(eventType).toLowerCase())) {
      statusLog("skip status handler for message-type eventType (handled above)");
      return res.status(200).json({ success: true, message: "message event delegated" });
    }

    const statusKind = classifyWatiStatusEvent(eventType, statusString);
    const contactPhone = normalizedPhone || normalizeWaId(inbound.waId);
    const eventTs = parseTimestamp(timestampRaw);

    const syncFarmerLeadActivity = async (status, extraSet = {}) => {
      if (!localMessageId) return;
      const $set = {
        "whatsappAutomationActivities.$.status": status,
        ...extraSet,
      };
      await Farmer.updateOne(
        { "whatsappAutomationActivities.localMessageId": localMessageId },
        { $set }
      ).catch(() => {});
      await FarmerLead.updateOne(
        { "whatsappAutomationActivities.localMessageId": localMessageId },
        { $set }
      ).catch(() => {});
    };

    const markPendingActivitySent = async () => {
      if (!contactPhone) return;
      const phone10 = contactPhone.length >= 10 ? contactPhone.slice(-10) : contactPhone;
      const update = {
        $set: {
          "whatsappAutomationActivities.$[elem].status": "sent",
          "whatsappAutomationActivities.$[elem].localMessageId": localMessageId || null,
          "whatsappAutomationActivities.$[elem].whatsappMessageId": whatsappMessageId || null,
          "whatsappAutomationActivities.$[elem].timestamp": eventTs,
        },
      };
      const arrayFilters = [
        { "elem.status": { $in: ["pending"] }, "elem.localMessageId": { $in: [null, ""] } },
      ];
      await Farmer.updateOne({ mobileNumber: parseInt(phone10, 10) }, update, { arrayFilters }).catch(() => {});
      await FarmerLead.updateOne({ mobileNumber: phone10 }, update, { arrayFilters }).catch(() => {});
    };

    if (statusKind === "sent") {
      await markPendingActivitySent();
      const broadcastResult = await updateBroadcastContactStatus({
        localMessageId,
        whatsappMessageId,
        phone: contactPhone,
        status: "sent",
        broadcastName,
      });
      statusLog("sent", {
        eventType,
        localMessageId,
        whatsappMessageId,
        contactPhone,
        broadcastResult,
      });
      return res.status(200).json({ success: true, message: "processed sent" });
    }

    if (statusKind === "delivered") {
      if (!localMessageId && !whatsappMessageId && !contactPhone) {
        return res.status(200).json({ success: false, message: "no identifier" });
      }
      await syncFarmerLeadActivity("delivered", {
        "whatsappAutomationActivities.$.deliveredAt": eventTs,
      });
      const broadcastResult = await updateBroadcastContactStatus({
        localMessageId,
        whatsappMessageId,
        phone: contactPhone,
        status: "delivered",
        deliveredAt: eventTs,
        broadcastName,
      });
      statusLog("delivered", { eventType, localMessageId, whatsappMessageId, contactPhone, broadcastResult });
      if (shouldUpdateFarmReadyOutboundStatus(body, eventType)) {
        await applyOutboundStatusUpdate({
          localMessageId,
          watiWebhookId,
          whatsappMessageId,
          event: "delivered",
          timestamp: eventTs,
        });
      }
      return res.status(200).json({ success: true, message: "processed delivered" });
    }

    if (statusKind === "read") {
      if (!localMessageId && !whatsappMessageId && !contactPhone) {
        return res.status(200).json({ success: false, message: "no identifier" });
      }
      await syncFarmerLeadActivity("read", {
        "whatsappAutomationActivities.$.readAt": eventTs,
      });
      const broadcastResult = await updateBroadcastContactStatus({
        localMessageId,
        whatsappMessageId,
        phone: contactPhone,
        status: "read",
        readAt: eventTs,
        deliveredAt: eventTs,
        broadcastName,
      });
      statusLog("read", { eventType, localMessageId, whatsappMessageId, contactPhone, broadcastResult });
      if (shouldUpdateFarmReadyOutboundStatus(body, eventType)) {
        await applyOutboundStatusUpdate({
          localMessageId,
          watiWebhookId,
          whatsappMessageId,
          event: "read",
          timestamp: eventTs,
        });
      }
      return res.status(200).json({ success: true, message: "processed read" });
    }

    if (statusKind === "failed") {
      if (!localMessageId && !contactPhone) {
        return res.status(200).json({ success: false, message: "no identifier" });
      }
      if (localMessageId) {
        await syncFarmerLeadActivity("failed", {
          "whatsappAutomationActivities.$.failedCode": failedCode || null,
          "whatsappAutomationActivities.$.failedDetail": failedDetail || null,
        });
      } else if (contactPhone) {
        const phone10 = contactPhone.length >= 10 ? contactPhone.slice(-10) : contactPhone;
        const update = {
          $set: {
            "whatsappAutomationActivities.$[elem].status": "failed",
            "whatsappAutomationActivities.$[elem].failedCode": failedCode || null,
            "whatsappAutomationActivities.$[elem].failedDetail": failedDetail || null,
          },
        };
        const arrayFilters = [{ "elem.status": { $in: ["pending", "sent"] } }];
        await Farmer.updateOne({ mobileNumber: parseInt(phone10, 10) }, update, { arrayFilters }).catch(() => {});
        await FarmerLead.updateOne({ mobileNumber: phone10 }, update, { arrayFilters }).catch(() => {});
      }
      const broadcastResult = await updateBroadcastContactStatus({
        localMessageId,
        whatsappMessageId,
        phone: contactPhone,
        status: "failed",
        failedCode,
        failedDetail,
        broadcastName,
      });
      statusLog("failed", { eventType, localMessageId, contactPhone, failedCode, failedDetail, broadcastResult });
      await applyOutboundStatusUpdate({
        localMessageId,
        watiWebhookId,
        whatsappMessageId,
        event: "failed",
        timestamp: eventTs,
        failedCode,
        failedDetail,
      });
      return res.status(200).json({ success: true, message: "processed failed" });
    }

    if (statusKind === "replied") {
      const replyText =
        body.text ||
        body.replyText ||
        body.data?.text ||
        inbound.text ||
        inbound.buttonText ||
        "";
      await recordBroadcastContactReply({
        phone: contactPhone,
        replyText,
        repliedAt: eventTs,
        localMessageId,
        broadcastName,
      });
      statusLog("replied", {
        eventType,
        localMessageId,
        contactPhone,
        replyText: String(replyText).slice(0, 80),
      });
      return res.status(200).json({ success: true, message: "processed reply" });
    }

    statusLog("ignored event", { eventType, statusString, statusKind });
    return res.status(200).json({ success: true, message: "ignored event", eventType });
  } catch (err) {
    console.error('❌ [WATI STATUS WEBHOOK] Error:', err.message);
    return res.status(200).json({ success: false, message: err.message });
  }
});

export const statusWebhookHealth = catchAsync(async (req, res) => {
  return res.status(200).json({
    success: true,
    message: "WATI unified webhook active (template status + messageReceived)",
    url: "/api/v1/whatsapp-status/webhook",
    events: [
      "templateMessageSent_v2",
      "sentMessageDELIVERED_v2",
      "sentMessageREAD_v2",
      "templateMessageFailed",
      "sentMessageReplied_v2",
      "messageReceived",
    ],
    timestamp: new Date().toISOString(),
  });
});

