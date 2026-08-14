import WhatsAppBroadcast from "../models/whatsappBroadcast.model.js";

function phoneVariants(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return [];
  const phone10 = digits.length >= 10 ? digits.slice(-10) : digits;
  const fullPhone = phone10.length === 10 ? `91${phone10}` : digits;
  return [...new Set([fullPhone, phone10, phone, digits].filter(Boolean))];
}

/**
 * Store farmer reply on the most recent matching broadcast contact (by localMessageId or phone).
 */
export async function recordBroadcastContactReply({
  phone,
  replyText,
  repliedAt = new Date(),
  broadcastName = null,
  localMessageId = null,
}) {
  const text = String(replyText || "").trim();
  if (!text) return null;

  const phoneMatch = phoneVariants(phone);
  if (!phoneMatch.length && !localMessageId) return null;

  if (localMessageId) {
    const byMsg = await WhatsAppBroadcast.findOne({
      "contacts.localMessageId": localMessageId,
      ...(broadcastName ? { name: broadcastName } : {}),
    })
      .select("_id name")
      .lean()
      .catch(() => null);
    if (byMsg) {
      await WhatsAppBroadcast.updateOne(
        { _id: byMsg._id },
        {
          $set: {
            "contacts.$[c].replyText": text,
            "contacts.$[c].repliedAt": repliedAt,
          },
        },
        {
          arrayFilters: [
            {
              $or: [
                { "c.localMessageId": localMessageId },
                ...(phoneMatch.length ? [{ "c.phone": { $in: phoneMatch } }] : []),
              ],
            },
          ],
        }
      ).catch(() => {});
      return byMsg._id;
    }
  }

  const query = {
    ...(broadcastName ? { name: broadcastName } : {}),
    ...(phoneMatch.length ? { "contacts.phone": { $in: phoneMatch } } : {}),
  };
  if (!Object.keys(query).length) return null;

  const broadcast = await WhatsAppBroadcast.findOne(query).sort({ sentAt: -1 }).select("_id").lean().catch(() => null);
  if (!broadcast) return null;

  await WhatsAppBroadcast.updateOne(
    { _id: broadcast._id },
    {
      $set: {
        "contacts.$[c].replyText": text,
        "contacts.$[c].repliedAt": repliedAt,
      },
    },
    { arrayFilters: [{ "c.phone": { $in: phoneMatch } }] }
  ).catch(() => {});

  return broadcast._id;
}
