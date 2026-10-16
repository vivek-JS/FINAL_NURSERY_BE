import NotificationInbox from "../models/notificationInbox.model.js";

const DEDUPE_WINDOW_MS = 3 * 60 * 1000;

/**
 * Writes one inbox row per user per `dedupeKey` inside a short window.
 * Status-change hooks fire from several paths (save, findOneAndUpdate, factory update),
 * so the same event can arrive more than once.
 */
export async function persistInboxOnce({ userId, title, body, type = "custom", data = {}, dedupeKey }) {
  if (!userId || !title || !body) return null;
  try {
    if (dedupeKey) {
      const existing = await NotificationInbox.findOne({
        user: userId,
        "data.dedupeKey": dedupeKey,
        createdAt: { $gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
      })
        .select("_id")
        .lean();
      if (existing) return existing;
    }
    return await NotificationInbox.create({
      user: userId,
      title,
      body,
      type,
      data: dedupeKey ? { ...data, dedupeKey } : data,
    });
  } catch (err) {
    console.error("[notificationInbox] persist failed:", err?.message || err);
    return null;
  }
}

export function orderNotifyUserId(order) {
  const dealerId = order?.dealer?._id || order?.dealer;
  const salesPersonId = order?.salesPerson?._id || order?.salesPerson;
  return dealerId || salesPersonId || null;
}
