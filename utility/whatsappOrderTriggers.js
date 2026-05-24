/** Shared triggers so report wizard does not block the order bot. */

export const ORDER_TRIGGERS = new Set([
  "order",
  "ऑर्डर",
  "book",
  "booking",
  "बुकिंग",
  "hi",
  "hello",
  "start",
  "नमस्कार",
  "namaskar",
]);

export function isOrderBotTrigger(text) {
  const t = String(text || "").trim().toLowerCase();
  return ORDER_TRIGGERS.has(t);
}
