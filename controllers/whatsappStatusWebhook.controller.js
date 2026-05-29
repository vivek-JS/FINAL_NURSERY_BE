import catchAsync from "../utility/catchAsync.js";
import Farmer from "../models/farmer.model.js";
import FarmerLead from "../models/farmerLead.model.js";
import WhatsAppBroadcast from "../models/whatsappBroadcast.model.js";
import { runFarmReadyWebhookFromBody } from "../services/whatsappFarmReadyReschedule.service.js";
import { runCancelReviveWebhookFromBody } from "../services/whatsappOrderCancelRevive.service.js";
import { runWhatsappReportWizardFromWebhookBody } from "../services/whatsappReportWizard.service.js";
import { runTodayBookingPdfJob } from "../services/bookingReportWebhook.service.js";
import { updateOutboundFromStatusWebhook } from "../services/orderWhatsappOutbound.service.js";
import {
  extractInboundMessage,
} from "../utility/watiInboundPayload.js";

const WATI_STATUS_DEBUG =
  process.env.WATI_STATUS_WEBHOOK_DEBUG !== "false";

function statusLog(...args) {
  if (WATI_STATUS_DEBUG) console.log("[WATI STATUS]", ...args);
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

function isInboundMessageEvent(body, eventType) {
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

  const eventType = body.eventType || body.type || body.event;
  const localMessageId =
    body.localMessageId || body.id || body.data?.localMessageId || body.data?.id || null;
  const waId = body.waId || body.whatsappId || body.data?.waId || body.data?.from || null;
  const statusString = body.statusString || body.status || null;
  const whatsappMessageId = body.whatsappMessageId || null;
  const timestampRaw =
    body.timestamp || body.created || body.data?.timestamp || new Date().toISOString();
  const failedCode = body.failedCode || body.data?.failedCode || null;
  const failedDetail = body.failedDetail || body.data?.failedDetail || null;

  const normalizedPhone = normalizeWaId(waId);
  const inbound = extractInboundMessage(body);

  statusLog("parsed", {
    eventType: eventType || "(none)",
    statusString: statusString || "(none)",
    waId: waId || "(none)",
    localMessageId: localMessageId || "(none)",
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

    // Handle templateMessageSent_v2 (mark pending activity as sent and store localMessageId)
    if (eventType === 'templateMessageSent_v2' || String(statusString).toLowerCase() === 'sent') {
      if (normalizedPhone) {
        const phone10 = normalizedPhone;
        const fullPhone = phone10.length === 10 ? `91${phone10}` : phone10;
        // Find pending activity first to get broadcastName for WhatsAppBroadcast update
        let broadcastName = null;
        const farmer = await Farmer.findOne({ mobileNumber: parseInt(phone10) }).lean().catch(() => null);
        if (farmer) {
          const act = (farmer.whatsappAutomationActivities || []).find(a => a.status === 'pending' && !a.localMessageId);
          if (act) broadcastName = act.broadcastName || null;
        }
        if (!broadcastName) {
          const lead = await FarmerLead.findOne({ mobileNumber: phone10 }).lean().catch(() => null);
          if (lead) {
            const act = (lead.whatsappAutomationActivities || []).find(a => a.status === 'pending' && !a.localMessageId);
            if (act) broadcastName = act.broadcastName || null;
          }
        }
        // Update Farmer activities
        const update = {
          $set: {
            'whatsappAutomationActivities.$[elem].status': 'sent',
            'whatsappAutomationActivities.$[elem].localMessageId': localMessageId || null,
            'whatsappAutomationActivities.$[elem].whatsappMessageId': whatsappMessageId || null,
            'whatsappAutomationActivities.$[elem].timestamp': parseTimestamp(timestampRaw)
          }
        };
        const arrayFilters = [{ 'elem.status': { $in: ['pending'] }, 'elem.localMessageId': { $in: [null, ''] } }];
        await Farmer.updateOne({ mobileNumber: parseInt(phone10) }, update, { arrayFilters }).catch(() => {});
        await FarmerLead.updateOne({ mobileNumber: phone10 }, update, { arrayFilters }).catch(() => {});
        statusLog("templateMessageSent_v2", { phone10, localMessageId, broadcastName: broadcastName || "(none)" });
        // Update WhatsAppBroadcast contact status for proper counts
        if (broadcastName && localMessageId) {
          await WhatsAppBroadcast.updateOne(
            { name: broadcastName },
            { $set: { 'contacts.$[c].status': 'sent', 'contacts.$[c].localMessageId': localMessageId, 'contacts.$[c].whatsappMessageId': whatsappMessageId || null } },
            { arrayFilters: [{ 'c.phone': { $in: [fullPhone, phone10] } }] }
          ).catch(() => {});
        } else if (localMessageId) {
          // Fallback: no Farmer/Lead activity - find broadcast by contact phone (most recent)
          const b = await WhatsAppBroadcast.findOne({
            'contacts.phone': { $in: [fullPhone, phone10] }
          }).sort({ sentAt: -1 }).select('name').lean().catch(() => null);
          if (b) {
            await WhatsAppBroadcast.updateOne(
              { name: b.name },
              { $set: { 'contacts.$[c].status': 'sent', 'contacts.$[c].localMessageId': localMessageId, 'contacts.$[c].whatsappMessageId': whatsappMessageId || null } },
              { arrayFilters: [{ 'c.phone': { $in: [fullPhone, phone10] } }] }
            ).catch(() => {});
          }
        }
      }
      await updateOutboundFromStatusWebhook({
        localMessageId,
        whatsappMessageId,
        event: "sent",
        timestamp: parseTimestamp(timestampRaw),
      }).catch(() => {});
      return res.status(200).json({ success: true, message: 'processed templateMessageSent_v2' });
    }

    // For delivered/read/failed events, use localMessageId or id to find and update
    if (eventType === 'sentMessageDELIVERED' || eventType === 'sentMessageDELIVERED_v2' || String(statusString).toLowerCase() === 'delivered') {
      if (!localMessageId) return res.status(200).json({ success: false, message: 'no localMessageId' });
      const deliveredAt = parseTimestamp(timestampRaw);
      // Find activity to get broadcastName and phone for WhatsAppBroadcast update
      let broadcastName = null, contactPhone = null;
      const f = await Farmer.findOne({ 'whatsappAutomationActivities.localMessageId': localMessageId }).lean().catch(() => null);
      if (f) {
        const act = (f.whatsappAutomationActivities || []).find(a => a.localMessageId === localMessageId);
        if (act) { broadcastName = act.broadcastName; contactPhone = act.phone || String(f.mobileNumber || ''); }
      }
      if (!broadcastName) {
        const l = await FarmerLead.findOne({ 'whatsappAutomationActivities.localMessageId': localMessageId }).lean().catch(() => null);
        if (l) {
          const act = (l.whatsappAutomationActivities || []).find(a => a.localMessageId === localMessageId);
          if (act) { broadcastName = act.broadcastName; contactPhone = act.phone || String(l.mobileNumber || ''); }
        }
      }
      if (!broadcastName) {
        const b = await WhatsAppBroadcast.findOne({ 'contacts.localMessageId': localMessageId }).select('name').lean().catch(() => null);
        if (b) broadcastName = b.name;
      }
      if (!broadcastName && whatsappMessageId) {
        const b = await WhatsAppBroadcast.findOne({ 'contacts.whatsappMessageId': whatsappMessageId }).select('name').lean().catch(() => null);
        if (b) broadcastName = b.name;
      }
      await Farmer.updateOne(
        { 'whatsappAutomationActivities.localMessageId': localMessageId },
        { $set: { 'whatsappAutomationActivities.$.status': 'delivered', 'whatsappAutomationActivities.$.deliveredAt': deliveredAt } }
      ).catch(() => {});
      await FarmerLead.updateOne(
        { 'whatsappAutomationActivities.localMessageId': localMessageId },
        { $set: { 'whatsappAutomationActivities.$.status': 'delivered', 'whatsappAutomationActivities.$.deliveredAt': deliveredAt } }
      ).catch(() => {});
      if (broadcastName) {
        const digits = String(contactPhone || '').replace(/\D/g, '');
        const phone10 = digits.length >= 10 ? digits.slice(-10) : digits;
        const fullPhone = digits.length === 10 ? `91${digits}` : digits;
        const phoneMatch = [fullPhone, phone10, contactPhone].filter(Boolean);
        const arrayFilter = {
          $or: [
            { 'c.localMessageId': localMessageId },
            ...(whatsappMessageId ? [{ 'c.whatsappMessageId': whatsappMessageId }] : []),
            ...(phoneMatch.length ? [{ 'c.phone': { $in: phoneMatch } }] : [])
          ]
        };
        await WhatsAppBroadcast.updateOne(
          { name: broadcastName },
          { $set: { 'contacts.$[c].status': 'delivered', 'contacts.$[c].deliveredAt': deliveredAt } },
          { arrayFilters: [arrayFilter] }
        ).catch(() => {});
      }
      statusLog("delivered", { localMessageId, broadcastName: broadcastName || "(none)" });
      await updateOutboundFromStatusWebhook({
        localMessageId,
        whatsappMessageId,
        event: "delivered",
        timestamp: deliveredAt,
      }).catch(() => {});
      return res.status(200).json({ success: true, message: "processed delivered" });
    }

    if (eventType === 'sentMessageREAD' || eventType === 'sentMessageREAD_v2' || String(statusString).toLowerCase() === 'read') {
      if (!localMessageId) return res.status(200).json({ success: false, message: 'no localMessageId' });
      const readAt = parseTimestamp(timestampRaw);
      let broadcastName = null, contactPhone = null;
      const f = await Farmer.findOne({ 'whatsappAutomationActivities.localMessageId': localMessageId }).lean().catch(() => null);
      if (f) {
        const act = (f.whatsappAutomationActivities || []).find(a => a.localMessageId === localMessageId);
        if (act) { broadcastName = act.broadcastName; contactPhone = act.phone || String(f.mobileNumber || ''); }
      }
      if (!broadcastName) {
        const l = await FarmerLead.findOne({ 'whatsappAutomationActivities.localMessageId': localMessageId }).lean().catch(() => null);
        if (l) {
          const act = (l.whatsappAutomationActivities || []).find(a => a.localMessageId === localMessageId);
          if (act) { broadcastName = act.broadcastName; contactPhone = act.phone || String(l.mobileNumber || ''); }
        }
      }
      if (!broadcastName) {
        const b = await WhatsAppBroadcast.findOne({ 'contacts.localMessageId': localMessageId }).select('name').lean().catch(() => null);
        if (b) broadcastName = b.name;
      }
      if (!broadcastName && whatsappMessageId) {
        const b = await WhatsAppBroadcast.findOne({ 'contacts.whatsappMessageId': whatsappMessageId }).select('name').lean().catch(() => null);
        if (b) broadcastName = b.name;
      }
      await Farmer.updateOne(
        { 'whatsappAutomationActivities.localMessageId': localMessageId },
        { $set: { 'whatsappAutomationActivities.$.status': 'read', 'whatsappAutomationActivities.$.readAt': readAt } }
      ).catch(() => {});
      await FarmerLead.updateOne(
        { 'whatsappAutomationActivities.localMessageId': localMessageId },
        { $set: { 'whatsappAutomationActivities.$.status': 'read', 'whatsappAutomationActivities.$.readAt': readAt } }
      ).catch(() => {});
      if (broadcastName) {
        const digits = String(contactPhone || '').replace(/\D/g, '');
        const phone10 = digits.length >= 10 ? digits.slice(-10) : digits;
        const fullPhone = digits.length === 10 ? `91${digits}` : digits;
        const phoneMatch = [fullPhone, phone10, contactPhone].filter(Boolean);
        const arrayFilter = {
          $or: [
            { 'c.localMessageId': localMessageId },
            ...(whatsappMessageId ? [{ 'c.whatsappMessageId': whatsappMessageId }] : []),
            ...(phoneMatch.length ? [{ 'c.phone': { $in: phoneMatch } }] : [])
          ]
        };
        await WhatsAppBroadcast.updateOne(
          { name: broadcastName },
          { $set: { 'contacts.$[c].status': 'read', 'contacts.$[c].readAt': readAt } },
          { arrayFilters: [arrayFilter] }
        ).catch(() => {});
      }
      statusLog("read", { localMessageId, broadcastName: broadcastName || "(none)" });
      await updateOutboundFromStatusWebhook({
        localMessageId,
        whatsappMessageId,
        event: "read",
        timestamp: readAt,
      }).catch(() => {});
      return res.status(200).json({ success: true, message: "processed read" });
    }

    if (eventType === 'templateMessageFailed' || String(statusString).toLowerCase() === 'failed') {
      if (!localMessageId && !normalizedPhone) return res.status(200).json({ success: false, message: 'no identifier' });
      const setObj = {
        'whatsappAutomationActivities.$.status': 'failed',
        'whatsappAutomationActivities.$.failedCode': failedCode || null,
        'whatsappAutomationActivities.$.failedDetail': failedDetail || null
      };
      let broadcastName = null, contactPhone = null;
      if (localMessageId) {
        await Farmer.updateOne({ 'whatsappAutomationActivities.localMessageId': localMessageId }, { $set: setObj }).catch(() => {});
        await FarmerLead.updateOne({ 'whatsappAutomationActivities.localMessageId': localMessageId }, { $set: setObj }).catch(() => {});
        const f = await Farmer.findOne({ 'whatsappAutomationActivities.localMessageId': localMessageId }).lean().catch(() => null);
        if (f) {
          const act = (f.whatsappAutomationActivities || []).find(a => a.localMessageId === localMessageId);
          if (act) { broadcastName = act.broadcastName; contactPhone = act.phone || String(f.mobileNumber || ''); }
        }
        if (!broadcastName) {
          const l = await FarmerLead.findOne({ 'whatsappAutomationActivities.localMessageId': localMessageId }).lean().catch(() => null);
          if (l) {
            const act = (l.whatsappAutomationActivities || []).find(a => a.localMessageId === localMessageId);
            if (act) { broadcastName = act.broadcastName; contactPhone = act.phone || String(l.mobileNumber || ''); }
          }
        }
        if (!broadcastName) {
          const b = await WhatsAppBroadcast.findOne({ 'contacts.localMessageId': localMessageId }).select('name').lean().catch(() => null);
          if (b) broadcastName = b.name;
        }
      } else if (normalizedPhone) {
        const f = await Farmer.findOne({ mobileNumber: parseInt(normalizedPhone) }).lean().catch(() => null);
        if (f) {
          const act = (f.whatsappAutomationActivities || []).find(a => a.status === 'pending');
          if (act) { broadcastName = act.broadcastName; contactPhone = String(f.mobileNumber || ''); }
        }
        if (!broadcastName) {
          const l = await FarmerLead.findOne({ mobileNumber: normalizedPhone }).lean().catch(() => null);
          if (l) {
            const act = (l.whatsappAutomationActivities || []).find(a => a.status === 'pending');
            if (act) { broadcastName = act.broadcastName; contactPhone = String(l.mobileNumber || ''); }
          }
        }
        const update = { $set: { 'whatsappAutomationActivities.$[elem].status': 'failed', 'whatsappAutomationActivities.$[elem].failedCode': failedCode || null, 'whatsappAutomationActivities.$[elem].failedDetail': failedDetail || null } };
        const arrayFilters = [{ 'elem.status': { $in: ['pending'] } }];
        await Farmer.updateOne({ mobileNumber: parseInt(normalizedPhone) }, update, { arrayFilters }).catch(() => {});
        await FarmerLead.updateOne({ mobileNumber: normalizedPhone }, update, { arrayFilters }).catch(() => {});
      }
      if (broadcastName) {
        const digits = String(contactPhone || normalizedPhone || '').replace(/\D/g, '');
        const phone10 = digits.length >= 10 ? digits.slice(-10) : digits;
        const fullPhone = digits.length === 10 ? `91${digits}` : digits;
        const phoneMatch = [fullPhone, phone10, contactPhone, normalizedPhone].filter(Boolean);
        await WhatsAppBroadcast.updateOne(
          { name: broadcastName },
          { $set: { 'contacts.$[c].status': 'failed' } },
          { arrayFilters: [{ $or: [{ 'c.localMessageId': localMessageId }, ...(phoneMatch.length ? [{ 'c.phone': { $in: phoneMatch } }] : [])] }] }
        ).catch(() => {});
      }
      statusLog("failed", { localMessageId, normalizedPhone, failedCode, failedDetail });
      await updateOutboundFromStatusWebhook({
        localMessageId,
        whatsappMessageId,
        event: "failed",
        timestamp: parseTimestamp(timestampRaw),
        failedCode,
        failedDetail,
      }).catch(() => {});
      return res.status(200).json({ success: true, message: "processed failed" });
    }

    statusLog("ignored event", { eventType, statusString });
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
      "messageReceived",
    ],
    timestamp: new Date().toISOString(),
  });
});

