/**
 * Shared helpers for parsing WATI inbound webhook bodies (message text + sender id).
 */

function pickString(...values) {
  for (const v of values) {
    if (v == null) continue;
    const s = typeof v === "string" ? v.trim() : String(v).trim();
    if (s) return s;
  }
  return "";
}

export function extractInboundMessage(body) {
  const b = body || {};

  const buttonOrList =
    pickString(
      b.buttonText,
      b.buttonReply?.text,
      b.buttonReply?.buttonText,
      b.interactiveButtonReply?.title,
      b.listReply?.title,
      b.listReply?.description,
      b.data?.buttonText,
      b.data?.buttonReply?.text,
      b.data?.listReply?.title,
      b.whatsappMessage?.buttonText,
      b.event?.message?.buttonText
    ) || "";

  const textField =
    pickString(
      b.text,
      b.messageText,
      b.content,
      b.message?.text,
      b.message?.body,
      b.whatsappMessage?.text,
      b.data?.text,
      b.data?.text?.body,
      b.payload?.text,
      b.event?.message?.text
    ) || "";

  const text = buttonOrList || textField;

  const waId =
    pickString(
      b.waId,
      b.wa_id,
      b.whatsappNumber,
      b.whatsapp_number,
      b.sender?.wa_id,
      b.sender?.waId,
      b.whatsappMessage?.waId,
      b.whatsappMessage?.sender?.wa_id,
      b.data?.waId,
      b.data?.from,
      b.event?.sender?.wa_id
    ) || "";

  return {
    text: typeof text === "string" ? text : String(text ?? ""),
    waId: typeof waId === "string" ? waId : String(waId ?? ""),
    buttonText: buttonOrList,
  };
}

/**
 * Best-effort WATI / Meta message id for deduping duplicate webhook deliveries.
 */
export function extractInboundMessageId(body) {
  const b = body || {};
  const candidates = [
    b.whatsappMessageId,
    b.messageId,
    b.id,
    b.localMessageId,
    b.data?.whatsappMessageId,
    b.data?.id,
    b.data?.messageId,
    b.whatsappMessage?.id,
    b.event?.message?.id,
    b.payload?.id,
    b.message?.id,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim()) {
      return String(c).trim();
    }
  }
  return "";
}

/** E.164-style digits for WATI sendSessionFileMessage / sendSessionMessage */
export function normalizeWhatsAppNumberForWati(waId) {
  const digits = String(waId || "").replace(/\D/g, "");
  if (!digits) {
    return "";
  }
  if (digits.length === 10) {
    return `91${digits}`;
  }
  return digits;
}
