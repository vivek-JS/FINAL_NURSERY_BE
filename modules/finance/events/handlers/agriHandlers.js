import { JournalBuilder } from "../../posting/journalBuilder.js";
import { ACCOUNT_CODES, FINANCIAL_EVENT_TYPES, PARTY_TYPES } from "../../domain/constants.js";
import { roundMoney } from "../../domain/roundMoney.js";

export function buildJournalForAgriEvent(eventType, payload) {
  const amount = roundMoney(payload.amount);
  if (amount <= 0 && !payload.allowZero) return null;

  const partyExtras = {
    partyType: PARTY_TYPES.AGRI_CUSTOMER,
    partyId: String(payload.customerMobile || ""),
    sourceLineRef: payload.sourceLineRef,
    metadata: payload.metadata,
  };

  const b = new JournalBuilder();

  switch (eventType) {
    case FINANCIAL_EVENT_TYPES.AGRI_ORDER_CREATED:
      b.dr(ACCOUNT_CODES.AR_AGRI, amount, partyExtras);
      b.cr(ACCOUNT_CODES.SALES_AGRI, amount);
      break;

    case FINANCIAL_EVENT_TYPES.AGRI_PAYMENT_COLLECTED: {
      const cashAccount =
        payload.modeOfPayment === "Cash" ? ACCOUNT_CODES.CASH : ACCOUNT_CODES.PAYMENT_CLEARING;
      b.dr(cashAccount, amount);
      b.cr(ACCOUNT_CODES.AR_AGRI, amount, partyExtras);
      break;
    }

    case FINANCIAL_EVENT_TYPES.AGRI_PAYMENT_REVERSED:
      b.dr(ACCOUNT_CODES.AR_AGRI, amount, partyExtras);
      b.cr(
        payload.modeOfPayment === "Cash" ? ACCOUNT_CODES.CASH : ACCOUNT_CODES.PAYMENT_CLEARING,
        amount
      );
      break;

    case FINANCIAL_EVENT_TYPES.AGRI_ORDER_DELTA:
      if (payload.isIncrease) {
        b.dr(ACCOUNT_CODES.AR_AGRI, amount, partyExtras);
        b.cr(ACCOUNT_CODES.SALES_AGRI, amount);
      } else {
        b.dr(ACCOUNT_CODES.SALES_AGRI, amount);
        b.cr(ACCOUNT_CODES.AR_AGRI, amount, partyExtras);
      }
      break;

    case FINANCIAL_EVENT_TYPES.AGRI_SALES_RETURN:
      if (payload.refundPayout) {
        b.dr(ACCOUNT_CODES.SALES_RETURN, amount);
        b.cr(ACCOUNT_CODES.BANK_ICICI, amount);
      } else {
        b.dr(ACCOUNT_CODES.SALES_RETURN, amount);
        b.cr(ACCOUNT_CODES.AR_AGRI, amount, partyExtras);
      }
      break;

    case FINANCIAL_EVENT_TYPES.AGRI_MANUAL_ADJUSTMENT:
      if (payload.isDebit) {
        b.dr(ACCOUNT_CODES.AR_AGRI, amount, partyExtras);
        b.cr(ACCOUNT_CODES.SALES_AGRI, amount);
      } else {
        b.dr(ACCOUNT_CODES.SALES_AGRI, amount);
        b.cr(ACCOUNT_CODES.AR_AGRI, amount, partyExtras);
      }
      break;

    default:
      return null;
  }

  b.assertBalanced();
  return b.lines;
}
