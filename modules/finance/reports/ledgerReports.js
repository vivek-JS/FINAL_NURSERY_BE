import LedgerLine from "../ledger/models/ledgerLine.model.js";
import ChartOfAccount from "../ledger/models/chartOfAccount.model.js";
import { roundMoney } from "../domain/roundMoney.js";

export async function getPartyStatement({
  partyType,
  partyId,
  accountCode,
  startDate,
  endDate,
  tenantId = "default",
}) {
  const q = { tenantId, partyType, partyId: String(partyId) };
  if (accountCode) q.accountCode = accountCode;
  if (startDate || endDate) {
    q.entryDate = {};
    if (startDate) q.entryDate.$gte = new Date(startDate);
    if (endDate) q.entryDate.$lte = new Date(endDate);
  }

  const lines = await LedgerLine.find(q)
    .sort({ entryDate: 1, createdAt: 1 })
    .lean();

  let running = 0;
  const entries = lines.map((l) => {
    running = roundMoney(running + (l.debit || 0) - (l.credit || 0));
    return {
      ...l,
      runningBalance: running,
    };
  });

  return {
    partyType,
    partyId,
    accountCode: accountCode || "ALL_AR",
    openingBalance: 0,
    closingBalance: running,
    entries,
  };
}

export async function getTrialBalance({ startDate, endDate, branchId, tenantId = "default" }) {
  const match = { tenantId };
  if (branchId) match.branchId = branchId;
  if (startDate || endDate) {
    match.entryDate = {};
    if (startDate) match.entryDate.$gte = new Date(startDate);
    if (endDate) match.entryDate.$lte = new Date(endDate);
  }

  const rows = await LedgerLine.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$accountCode",
        totalDebit: { $sum: "$debit" },
        totalCredit: { $sum: "$credit" },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const accounts = await ChartOfAccount.find({ tenantId }).lean();
  const nameByCode = Object.fromEntries(accounts.map((a) => [a.code, a.name]));

  let grandDebit = 0;
  let grandCredit = 0;
  const lines = rows.map((r) => {
    const debit = roundMoney(r.totalDebit);
    const credit = roundMoney(r.totalCredit);
    grandDebit += debit;
    grandCredit += credit;
    return {
      accountCode: r._id,
      accountName: nameByCode[r._id] || r._id,
      debit,
      credit,
      balance: roundMoney(debit - credit),
    };
  });

  return {
    lines,
    totalDebit: roundMoney(grandDebit),
    totalCredit: roundMoney(grandCredit),
    isBalanced: roundMoney(grandDebit) === roundMoney(grandCredit),
  };
}

export async function getAccountBook({ accountCode, startDate, endDate, tenantId = "default" }) {
  const q = { tenantId, accountCode };
  if (startDate || endDate) {
    q.entryDate = {};
    if (startDate) q.entryDate.$gte = new Date(startDate);
    if (endDate) q.entryDate.$lte = new Date(endDate);
  }

  const lines = await LedgerLine.find(q).sort({ entryDate: 1, createdAt: 1 }).lean();
  let running = 0;
  const entries = lines.map((l) => {
    running = roundMoney(running + (l.debit || 0) - (l.credit || 0));
    return { ...l, runningBalance: running };
  });

  return { accountCode, closingBalance: running, entries };
}

/**
 * Paginated central ledger lines (all accounts or filtered).
 */
export async function getLedgerLinesList({
  tenantId = "default",
  partyType,
  partyId,
  accountCode,
  startDate,
  endDate,
  page = 1,
  limit = 50,
}) {
  const q = { tenantId };
  if (partyType) q.partyType = partyType;
  if (partyId) q.partyId = String(partyId);
  if (accountCode) q.accountCode = accountCode;
  if (startDate || endDate) {
    q.entryDate = {};
    if (startDate) q.entryDate.$gte = new Date(startDate);
    if (endDate) q.entryDate.$lte = new Date(endDate);
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const safePage = Math.max(Number(page) || 1, 1);
  const skip = (safePage - 1) * safeLimit;

  const [lines, total] = await Promise.all([
    LedgerLine.find(q)
      .sort({ entryDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .lean(),
    LedgerLine.countDocuments(q),
  ]);

  return {
    lines,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    },
  };
}
