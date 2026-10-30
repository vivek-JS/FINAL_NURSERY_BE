/**
 * Wraps a Baileys WAMessage in the small message shape the inbound handlers use
 * (order bot, agri load, campaign replies): from/body/fromMe/getContact/getChat/reply.
 * `from` is the phone JID when WhatsApp exposes it (LID chats are mapped back to the number).
 */
import {
  getContentType,
  isJidStatusBroadcast,
  isLidUser,
  jidDecode,
  jidNormalizedUser,
  normalizeMessageContent,
} from "baileys";

const MEDIA_TYPES = new Set([
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
]);

function extractText(content, type) {
  if (!content || !type) return "";
  const node = content[type];
  if (typeof node === "string") return node;
  return (
    node?.text ||
    node?.caption ||
    node?.selectedDisplayText ||
    node?.title ||
    node?.singleSelectReply?.selectedRowId ||
    ""
  );
}

async function resolvePhoneJid(key, socket) {
  const remote = key.remoteJid || "";
  if (!isLidUser(remote)) return jidNormalizedUser(remote);
  const alt = key.remoteJidAlt || key.senderPn;
  if (alt && !isLidUser(alt)) return jidNormalizedUser(alt);
  try {
    const pn = await socket?.signalRepository?.lidMapping?.getPNForLID(remote);
    if (pn) return jidNormalizedUser(pn);
  } catch {
    /* fall through to LID */
  }
  return remote;
}

async function sendOrThrow(sendText, jid, text, options) {
  const result = await sendText(jid, text, options);
  if (!result?.ok) throw new Error(result?.reason || "send_failed");
  return result;
}

export async function toInboundMessage(raw, { socket, sendText }) {
  const key = raw?.key || {};
  const chatJid = key.remoteJid || "";
  const content = normalizeMessageContent(raw?.message);
  const type = content ? getContentType(content) : undefined;
  const from = await resolvePhoneJid(key, socket);
  const user = jidDecode(from)?.user || "";
  const pushName = raw?.pushName || "";

  return {
    id: { id: key.id, _serialized: key.id },
    from,
    chatJid,
    body: extractText(content, type),
    fromMe: Boolean(key.fromMe),
    isStatus: isJidStatusBroadcast(chatJid),
    hasMedia: MEDIA_TYPES.has(type),
    type: type === "conversation" || type === "extendedTextMessage" ? "chat" : String(type || "unknown").replace(/Message$/, ""),
    _data: { notifyName: pushName, pushname: pushName },
    getContact: async () => ({
      number: isLidUser(from) ? null : user,
      pushname: pushName,
      name: pushName,
      id: { user, _serialized: from },
    }),
    getChat: async () => ({
      id: { user: jidDecode(chatJid)?.user || "", _serialized: chatJid },
      sendMessage: (text) => sendOrThrow(sendText, chatJid, text),
    }),
    reply: (text) => sendOrThrow(sendText, chatJid, text, { quoted: raw }),
  };
}
