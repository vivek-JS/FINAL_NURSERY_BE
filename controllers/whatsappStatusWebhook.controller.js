import catchAsync from "../utility/catchAsync.js";
import Farmer from "../models/farmer.model.js";
import FarmerLead from "../models/farmerLead.model.js";
import WhatsAppBroadcast from "../models/whatsappBroadcast.model.js";
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
  // Report wizard runs only from the inbound message webhook (order bot / opt-in).
  // Do not attach it here — duplicate delivery caused double menus / double "1" steps.

  const userAgent = req.headers['user-agent'] || '';
  const isWati = userAgent.toLowerCase().includes('wati');

  // Parse payload - WATI sends "id" when localMessageId is empty
  const body = req.body || {};
  const eventType = body.eventType || body.type || body.event;
  const localMessageId = body.localMessageId || body.id || body.data?.localMessageId || body.data?.id || null;
  const waId = body.waId || body.whatsappId || body.data?.waId || body.data?.from || null;
  const statusString = body.statusString || body.status || null;
  const whatsappMessageId = body.whatsappMessageId || null;
  const timestampRaw = body.timestamp || body.created || body.data?.timestamp || new Date().toISOString();
  const failedCode = body.failedCode || body.data?.failedCode || null;
  const failedDetail = body.failedDetail || body.data?.failedDetail || null;

  const normalizedPhone = normalizeWaId(waId);

  // Always respond 200 to WATI
  try {
    if (!eventType) {
      return res.status(200).json({ success: false, message: 'No eventType' });
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
      return res.status(200).json({ success: true, message: 'processed delivered' });
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
      return res.status(200).json({ success: true, message: 'processed read' });
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
      return res.status(200).json({ success: true, message: 'processed failed' });
    }

    // Unknown event
    return res.status(200).json({ success: true, message: 'ignored event' });
  } catch (err) {
    console.error('❌ [WATI STATUS WEBHOOK] Error:', err.message);
    return res.status(200).json({ success: false, message: err.message });
  }
});

export const statusWebhookHealth = catchAsync(async (req, res) => {
  return res.status(200).json({ success: true, message: 'WATI status webhook active', timestamp: new Date().toISOString() });
});

