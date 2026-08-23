import { FINANCIAL_EVENT_TYPES } from "./constants.js";

const TRANSFER_EVENTS = new Set([
  FINANCIAL_EVENT_TYPES.FARMER_ADVANCE_TRANSFER,
  FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_TRANSFER,
]);

export function isTransferEventType(eventType) {
  return TRANSFER_EVENTS.has(eventType);
}

export function describeFinancialEvent(eventType, payload = {}) {
  const amt = payload.amount != null ? `₹${Number(payload.amount).toLocaleString("en-IN")}` : "";
  switch (eventType) {
    case FINANCIAL_EVENT_TYPES.FARMER_ADVANCE_TRANSFER:
      if (payload.direction === "OUT") {
        return `Advance transfer out ${amt}`.trim();
      }
      if (payload.direction === "IN") {
        return `Advance transfer in ${amt}`.trim();
      }
      return `Advance transfer ${amt}`.trim();
    case FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_TRANSFER:
      if (payload.direction === "REVERSAL") {
        return `Payment transfer out (reversal) ${amt}`.trim();
      }
      if (payload.direction === "CREDIT") {
        return `Payment transfer in ${amt}`.trim();
      }
      return `Order payment transfer ${amt}`.trim();
    case FINANCIAL_EVENT_TYPES.FARMER_ORDER_CREATED:
      return `Plant order booked ${amt}`.trim();
    case FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_COLLECTED:
      return `Payment collected ${amt}`.trim();
    case FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_REVERSED:
      return `Payment reversed ${amt}`.trim();
    case FINANCIAL_EVENT_TYPES.FARMER_DISCOUNT:
      return `Discount approved ${amt}`.trim();
    case FINANCIAL_EVENT_TYPES.FARMER_DISCOUNT_REVERSED:
      return `Discount reversed ${amt}`.trim();
    case FINANCIAL_EVENT_TYPES.AGRI_ORDER_CREATED:
      return `Agri order booked ${amt}`.trim();
    case FINANCIAL_EVENT_TYPES.AGRI_PAYMENT_COLLECTED:
      return `Payment collected ${amt}`.trim();
    case FINANCIAL_EVENT_TYPES.AGRI_PAYMENT_REVERSED:
      return `Payment reversed ${amt}`.trim();
    default:
      return payload.description || String(eventType || "Ledger entry").replace(/_/g, " ");
  }
}

export function centralEntryCategoryLabel(line) {
  const eventType = line?.metadata?.eventType || line?.eventType;
  if (eventType === FINANCIAL_EVENT_TYPES.FARMER_ADVANCE_TRANSFER) {
    return "Advance transfer";
  }
  if (eventType === FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_TRANSFER) {
    return "Payment transfer";
  }
  if (
    eventType === FINANCIAL_EVENT_TYPES.FARMER_DISCOUNT ||
    eventType === FINANCIAL_EVENT_TYPES.FARMER_DISCOUNT_REVERSED
  ) {
    return "Discount";
  }
  if (isTransferEventType(eventType)) {
    return "Transfer";
  }
  return line?.accountCode || "AR";
}
