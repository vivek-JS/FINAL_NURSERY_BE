import { JournalBuilder } from "../../posting/journalBuilder.js";
import { ACCOUNT_CODES, FINANCIAL_EVENT_TYPES } from "../../domain/constants.js";
import { roundMoney } from "../../domain/roundMoney.js";

export function buildJournalForBankEvent(eventType, payload) {
  const amount = roundMoney(payload.amount);
  if (amount <= 0) return null;

  const b = new JournalBuilder();

  switch (eventType) {
    case FINANCIAL_EVENT_TYPES.BANK_STATEMENT_UNMATCHED:
      if (payload.isCredit) {
        b.dr(ACCOUNT_CODES.BANK_ICICI, amount);
        b.cr(ACCOUNT_CODES.SUSPENSE_BANK, amount);
      } else {
        b.dr(ACCOUNT_CODES.SUSPENSE_BANK, amount);
        b.cr(ACCOUNT_CODES.BANK_ICICI, amount);
      }
      break;

    case FINANCIAL_EVENT_TYPES.BANK_PAYMENT_VERIFIED:
      b.dr(ACCOUNT_CODES.BANK_ICICI, amount);
      b.cr(ACCOUNT_CODES.PAYMENT_CLEARING, amount);
      break;

    default:
      return null;
  }

  b.assertBalanced();
  return b.lines;
}
