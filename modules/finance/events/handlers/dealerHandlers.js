import { JournalBuilder } from "../../posting/journalBuilder.js";
import { ACCOUNT_CODES, FINANCIAL_EVENT_TYPES, PARTY_TYPES } from "../../domain/constants.js";
import { roundMoney } from "../../domain/roundMoney.js";

export function buildJournalForDealerEvent(eventType, payload) {
  const amount = roundMoney(payload.amount);
  if (amount <= 0 && !payload.allowZero) return null;

  const partyExtras = {
    partyType: PARTY_TYPES.DEALER,
    partyId: String(payload.dealerId || ""),
    sourceLineRef: payload.sourceLineRef,
    metadata: payload.metadata,
  };

  const b = new JournalBuilder();

  switch (eventType) {
    case FINANCIAL_EVENT_TYPES.DEALER_ORDER_BOOKING:
      b.dr(ACCOUNT_CODES.AR_DEALER, amount, partyExtras);
      b.cr(ACCOUNT_CODES.SALES_PLANTS, amount);
      break;

    case FINANCIAL_EVENT_TYPES.DEALER_ORDER_CANCEL:
      b.dr(ACCOUNT_CODES.SALES_PLANTS, amount);
      b.cr(ACCOUNT_CODES.AR_DEALER, amount, partyExtras);
      break;

    case FINANCIAL_EVENT_TYPES.DEALER_ORDER_REOPEN:
      b.dr(ACCOUNT_CODES.AR_DEALER, amount, partyExtras);
      b.cr(ACCOUNT_CODES.SALES_PLANTS, amount);
      break;

    case FINANCIAL_EVENT_TYPES.DEALER_RECEIVABLE_PAYMENT:
      b.dr(ACCOUNT_CODES.PAYMENT_CLEARING, amount);
      b.cr(ACCOUNT_CODES.AR_DEALER, amount, partyExtras);
      break;

    case FINANCIAL_EVENT_TYPES.DEALER_WALLET_MOVEMENT:
      if (payload.walletCredit) {
        b.dr(ACCOUNT_CODES.AR_FARMER, amount, {
          partyType: PARTY_TYPES.FARMER,
          partyId: String(payload.farmerPartyId || ""),
        });
        b.cr(ACCOUNT_CODES.DEALER_WALLET, amount, partyExtras);
      } else if (amount > 0) {
        b.dr(ACCOUNT_CODES.DEALER_WALLET, amount, partyExtras);
        b.cr(ACCOUNT_CODES.PAYMENT_CLEARING, amount);
      } else {
        b.dr(ACCOUNT_CODES.PAYMENT_CLEARING, amount);
        b.cr(ACCOUNT_CODES.DEALER_WALLET, Math.abs(amount), partyExtras);
      }
      break;

    case FINANCIAL_EVENT_TYPES.DEALER_COMMISSION_SETTLEMENT:
      b.dr(ACCOUNT_CODES.COMMISSION_EXPENSE, amount);
      b.cr(ACCOUNT_CODES.AR_DEALER, amount, partyExtras);
      break;

    default:
      return null;
  }

  b.assertBalanced();
  return b.lines;
}
