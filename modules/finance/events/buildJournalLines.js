import { FINANCIAL_EVENT_TYPES } from "../domain/constants.js";
import { buildJournalForFarmerEvent } from "./handlers/farmerHandlers.js";
import { buildJournalForAgriEvent } from "./handlers/agriHandlers.js";
import { buildJournalForDealerEvent } from "./handlers/dealerHandlers.js";
import { buildJournalForBankEvent } from "./handlers/bankHandlers.js";

const FARMER_EVENTS = new Set([
  FINANCIAL_EVENT_TYPES.FARMER_ORDER_CREATED,
  FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_COLLECTED,
  FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_REVERSED,
  FINANCIAL_EVENT_TYPES.FARMER_DISCOUNT,
  FINANCIAL_EVENT_TYPES.FARMER_DISCOUNT_REVERSED,
  FINANCIAL_EVENT_TYPES.FARMER_ORDER_DELTA,
  FINANCIAL_EVENT_TYPES.FARMER_ORDER_CANCEL,
  FINANCIAL_EVENT_TYPES.FARMER_ORDER_REOPEN,
  FINANCIAL_EVENT_TYPES.FARMER_DISPATCH_RETURN,
  FINANCIAL_EVENT_TYPES.FARMER_ADVANCE_TRANSFER,
  FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_TRANSFER,
  FINANCIAL_EVENT_TYPES.FARMER_MANUAL_ADJUSTMENT,
]);

const AGRI_EVENTS = new Set([
  FINANCIAL_EVENT_TYPES.AGRI_ORDER_CREATED,
  FINANCIAL_EVENT_TYPES.AGRI_PAYMENT_COLLECTED,
  FINANCIAL_EVENT_TYPES.AGRI_PAYMENT_REVERSED,
  FINANCIAL_EVENT_TYPES.AGRI_ORDER_DELTA,
  FINANCIAL_EVENT_TYPES.AGRI_SALES_RETURN,
  FINANCIAL_EVENT_TYPES.AGRI_MANUAL_ADJUSTMENT,
]);

const DEALER_EVENTS = new Set([
  FINANCIAL_EVENT_TYPES.DEALER_ORDER_BOOKING,
  FINANCIAL_EVENT_TYPES.DEALER_ORDER_CANCEL,
  FINANCIAL_EVENT_TYPES.DEALER_ORDER_REOPEN,
  FINANCIAL_EVENT_TYPES.DEALER_RECEIVABLE_PAYMENT,
  FINANCIAL_EVENT_TYPES.DEALER_WALLET_MOVEMENT,
  FINANCIAL_EVENT_TYPES.DEALER_COMMISSION_SETTLEMENT,
]);

const BANK_EVENTS = new Set([
  FINANCIAL_EVENT_TYPES.BANK_STATEMENT_UNMATCHED,
  FINANCIAL_EVENT_TYPES.BANK_PAYMENT_VERIFIED,
]);

export function buildJournalLines(eventType, payload) {
  if (FARMER_EVENTS.has(eventType)) {
    return buildJournalForFarmerEvent(eventType, payload);
  }
  if (AGRI_EVENTS.has(eventType)) {
    return buildJournalForAgriEvent(eventType, payload);
  }
  if (DEALER_EVENTS.has(eventType)) {
    return buildJournalForDealerEvent(eventType, payload);
  }
  if (BANK_EVENTS.has(eventType)) {
    return buildJournalForBankEvent(eventType, payload);
  }
  return null;
}

export function voucherTypeForEvent(eventType) {
  if (eventType.includes("PAYMENT_COLLECTED") || eventType.includes("RECEIVABLE_PAYMENT")) {
    return "RECEIPT";
  }
  if (eventType.includes("ORDER_CREATED") || eventType.includes("ORDER_BOOKING")) {
    return "SALES_INVOICE";
  }
  if (eventType.includes("REVERSAL") || eventType.includes("REVERSED")) {
    return "REVERSAL";
  }
  if (eventType.includes("SALES_RETURN") || eventType.includes("REFUND") || eventType.includes("DISCOUNT")) {
    return "CREDIT_NOTE";
  }
  if (eventType.includes("COMMISSION")) {
    return "JOURNAL";
  }
  if (eventType.includes("BANK")) {
    return "JOURNAL";
  }
  return "ADJUSTMENT";
}
