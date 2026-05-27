import Order from "../../../models/order.model.js";
import LedgerLine from "../ledger/models/ledgerLine.model.js";
import { ACCOUNT_CODES, PARTY_TYPES } from "../domain/constants.js";
import { roundMoney } from "../domain/roundMoney.js";
import { normalizeFarmerMobile } from "../../../utils/farmerPlantOrderLedgerHelper.js";

/**
 * When source=ledger, enrich order rows with central AR balances where farmer mobile is known.
 */
export async function applyLedgerBalancesToOrders(orders) {
  const farmerIds = new Set();
  for (const o of orders) {
    const m = normalizeFarmerMobile(o.farmerMobile || o.farmer?.mobileNumber);
    if (m) farmerIds.add(m);
  }

  const balanceByMobile = {};
  for (const mobile of farmerIds) {
    const lines = await LedgerLine.find({
      partyType: PARTY_TYPES.FARMER,
      partyId: mobile,
      accountCode: ACCOUNT_CODES.AR_FARMER,
    }).lean();
    let bal = 0;
    for (const l of lines) {
      bal += (l.debit || 0) - (l.credit || 0);
    }
    balanceByMobile[mobile] = roundMoney(bal);
  }

  return orders.map((o) => {
    const m = normalizeFarmerMobile(o.farmerMobile || o.farmer?.mobileNumber);
    if (!m || balanceByMobile[m] === undefined) return o;
    return {
      ...o,
      ledgerOutstanding: balanceByMobile[m],
      collectionSource: "ledger",
    };
  });
}

export async function getLedgerCollectedTotalForDateRange(startDate, endDate) {
  const match = {
    accountCode: { $in: [ACCOUNT_CODES.CASH, ACCOUNT_CODES.PAYMENT_CLEARING, ACCOUNT_CODES.BANK_ICICI] },
    credit: { $gt: 0 },
  };
  if (startDate || endDate) {
    match.entryDate = {};
    if (startDate) match.entryDate.$gte = new Date(startDate);
    if (endDate) match.entryDate.$lte = new Date(endDate);
  }
  const agg = await LedgerLine.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: "$credit" } } },
  ]);
  return roundMoney(agg[0]?.total || 0);
}
