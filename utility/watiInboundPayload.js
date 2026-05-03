/**
 * Shared helpers for parsing WATI inbound webhook bodies (message text + sender id).
 */

export function extractInboundMessage(body) {
  const text =
    body?.text ??
    body?.messageText ??
    body?.content ??
    body?.message?.text ??
    body?.whatsappMessage?.text ??
    body?.data?.text ??
    body?.payload?.text ??
    body?.event?.message?.text ??
    body?.buttonReply?.text ??
    "";

  const waId =
    body?.waId ??
    body?.wa_id ??
    body?.whatsappNumber ??
    body?.whatsapp_number ??
    body?.sender?.wa_id ??
    body?.sender?.waId ??
    body?.whatsappMessage?.waId ??
    body?.whatsappMessage?.sender?.wa_id ??
    body?.data?.waId ??
    body?.data?.from ??
    body?.event?.sender?.wa_id ??
    "";

  return {
    text: typeof text === "string" ? text : String(text ?? ""),
    waId: typeof waId === "string" ? waId : String(waId ?? ""),
  };
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
