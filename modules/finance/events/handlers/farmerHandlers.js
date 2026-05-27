import { JournalBuilder } from "../../posting/journalBuilder.js";
import { ACCOUNT_CODES, FINANCIAL_EVENT_TYPES, PARTY_TYPES, VOUCHER_TYPES } from "../../domain/constants.js";
import { roundMoney } from "../../domain/roundMoney.js";

function partyIdFromPayload(payload) {
  return payload.partyId || payload.customerMobile || payload.farmerId?.toString?.() || "";
}

export function buildJournalForFarmerEvent(eventType, payload) {
  const amount = roundMoney(payload.amount);
  if (amount <= 0 && !payload.allowZero) return null;

  const partyId = partyIdFromPayload(payload);
  const partyExtras = {
    partyType: PARTY_TYPES.FARMER,
    partyId: String(partyId),
    sourceLineRef: payload.sourceLineRef,
    metadata: payload.metadata,
  };

  const b = new JournalBuilder();

  switch (eventType) {
    case FINANCIAL_EVENT_TYPES.FARMER_ORDER_CREATED:
      b.dr(ACCOUNT_CODES.AR_FARMER, amount, partyExtras);
      b.cr(ACCOUNT_CODES.SALES_PLANTS, amount, { sourceLineRef: payload.sourceLineRef });
      break;

    case FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_COLLECTED: {
      const cashAccount =
        payload.modeOfPayment === "Cash" ? ACCOUNT_CODES.CASH : ACCOUNT_CODES.PAYMENT_CLEARING;
      b.dr(cashAccount, amount, { sourceLineRef: payload.sourceLineRef });
      b.cr(ACCOUNT_CODES.AR_FARMER, amount, partyExtras);
      break;
    }

    case FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_REVERSED:
      b.dr(ACCOUNT_CODES.AR_FARMER, amount, partyExtras);
      b.cr(
        payload.modeOfPayment === "Cash" ? ACCOUNT_CODES.CASH : ACCOUNT_CODES.PAYMENT_CLEARING,
        amount,
        { sourceLineRef: payload.sourceLineRef }
      );
      break;

    case FINANCIAL_EVENT_TYPES.FARMER_ORDER_DELTA:
      if (payload.isIncrease) {
        b.dr(ACCOUNT_CODES.AR_FARMER, amount, partyExtras);
        b.cr(ACCOUNT_CODES.SALES_PLANTS, amount);
      } else {
        b.dr(ACCOUNT_CODES.SALES_PLANTS, amount);
        b.cr(ACCOUNT_CODES.AR_FARMER, amount, partyExtras);
      }
      break;

    case FINANCIAL_EVENT_TYPES.FARMER_ORDER_CANCEL:
      b.dr(ACCOUNT_CODES.SALES_PLANTS, amount);
      b.cr(ACCOUNT_CODES.AR_FARMER, amount, partyExtras);
      break;

    case FINANCIAL_EVENT_TYPES.FARMER_ORDER_REOPEN:
      b.dr(ACCOUNT_CODES.AR_FARMER, amount, partyExtras);
      b.cr(ACCOUNT_CODES.SALES_PLANTS, amount);
      break;

    case FINANCIAL_EVENT_TYPES.FARMER_DISPATCH_RETURN:
      b.dr(ACCOUNT_CODES.SALES_RETURN, amount);
      b.cr(ACCOUNT_CODES.AR_FARMER, amount, partyExtras);
      break;

    case FINANCIAL_EVENT_TYPES.FARMER_ADVANCE_TRANSFER:
      if (payload.direction === "OUT") {
        b.dr(ACCOUNT_CODES.CUSTOMER_ADVANCE, amount, partyExtras);
        b.cr(ACCOUNT_CODES.AR_FARMER, amount, partyExtras);
      } else {
        b.dr(ACCOUNT_CODES.AR_FARMER, amount, partyExtras);
        b.cr(ACCOUNT_CODES.CUSTOMER_ADVANCE, amount, partyExtras);
      }
      break;

    case FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_TRANSFER:
      if (payload.direction === "REVERSAL") {
        b.dr(ACCOUNT_CODES.AR_FARMER, amount, partyExtras);
        b.cr(ACCOUNT_CODES.PAYMENT_CLEARING, amount);
      } else {
        b.dr(ACCOUNT_CODES.PAYMENT_CLEARING, amount);
        b.cr(ACCOUNT_CODES.AR_FARMER, amount, partyExtras);
      }
      break;

    case FINANCIAL_EVENT_TYPES.FARMER_MANUAL_ADJUSTMENT:
      if (payload.isDebit) {
        b.dr(ACCOUNT_CODES.AR_FARMER, amount, partyExtras);
        b.cr(ACCOUNT_CODES.SALES_PLANTS, amount);
      } else {
        b.dr(ACCOUNT_CODES.SALES_PLANTS, amount);
        b.cr(ACCOUNT_CODES.AR_FARMER, amount, partyExtras);
      }
      break;

    default:
      return null;
  }

  b.assertBalanced();
  return b.lines;
}
