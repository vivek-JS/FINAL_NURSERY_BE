import LedgerLine from "../ledger/models/ledgerLine.model.js";
import ChartOfAccount from "../ledger/models/chartOfAccount.model.js";
import JournalEntry from "../ledger/models/journalEntry.model.js";
import FinanceVoucher from "../ledger/models/financeVoucher.model.js";
import FinancialEvent from "../ledger/models/financialEvent.model.js";
import { ACCOUNT_CODES } from "../domain/constants.js";
import { describeFinancialEvent } from "../domain/eventLabels.js";
import { roundMoney } from "../domain/roundMoney.js";

async function enrichLedgerLinesWithEventType(lines) {
  if (!lines?.length) return lines;
  const journalIds = [...new Set(lines.map((l) => String(l.journalEntryId)).filter(Boolean))];
  if (!journalIds.length) return lines;

  const journals = await JournalEntry.find({ _id: { $in: journalIds } })
    .select("_id voucherId")
    .lean();
  const voucherByJournal = new Map(journals.map((j) => [String(j._id), j.voucherId]));
  const voucherIds = [...new Set([...voucherByJournal.values()].filter(Boolean).map(String))];
  if (!voucherIds.length) return lines;

  const vouchers = await FinanceVoucher.find({ _id: { $in: voucherIds } })
    .select("_id financialEventId description metadata")
    .lean();
  const voucherMap = new Map(vouchers.map((v) => [String(v._id), v]));
  const eventIds = [
    ...new Set(vouchers.map((v) => v.financialEventId).filter(Boolean).map(String)),
  ];
  const events = eventIds.length
    ? await FinancialEvent.find({ _id: { $in: eventIds } })
        .select("_id eventType payload")
        .lean()
    : [];
  const eventMap = new Map(events.map((e) => [String(e._id), e]));

  return lines.map((line) => {
    if (line.metadata?.eventType) return line;
    const voucherId = voucherByJournal.get(String(line.journalEntryId));
    const voucher = voucherId ? voucherMap.get(String(voucherId)) : null;
    const eventType =
      voucher?.metadata?.eventType ||
      (voucher?.financialEventId
        ? eventMap.get(String(voucher.financialEventId))?.eventType
        : null);
    const event = voucher?.financialEventId
      ? eventMap.get(String(voucher.financialEventId))
      : null;
    const description =
      voucher?.description ||
      (eventType ? describeFinancialEvent(eventType, event?.payload || {}) : line.metadata?.description);
    return {
      ...line,
      eventType,
      metadata: {
        ...(line.metadata || {}),
        ...(eventType ? { eventType } : {}),
        ...(event?.payload?.direction != null ? { direction: event.payload.direction } : {}),
        description,
      },
    };
  });
}

export async function getPartyStatement({
  partyType,
  partyId,
  accountCode,
  startDate,
  endDate,
  includeTransfers = false,
  tenantId = "default",
}) {
  const q = { tenantId, partyType, partyId: String(partyId) };
  if (accountCode) {
    q.accountCode = accountCode;
  } else if (includeTransfers && partyType === "FARMER") {
    q.accountCode = { $in: [ACCOUNT_CODES.AR_FARMER, ACCOUNT_CODES.CUSTOMER_ADVANCE] };
  } else if (includeTransfers && partyType === "AGRI_CUSTOMER") {
    q.accountCode = ACCOUNT_CODES.AR_AGRI;
  }
  if (startDate || endDate) {
    q.entryDate = {};
    if (startDate) q.entryDate.$gte = new Date(startDate);
    if (endDate) q.entryDate.$lte = new Date(endDate);
  }

  let lines = await LedgerLine.find(q)
    .sort({ entryDate: 1, createdAt: 1 })
    .lean();
  lines = await enrichLedgerLinesWithEventType(lines);

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
    accountCode: accountCode || (includeTransfers ? "AR_AND_ADVANCE" : "ALL_AR"),
    includeTransfers: Boolean(includeTransfers),
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

  let [lines, total] = await Promise.all([
    LedgerLine.find(q)
      .sort({ entryDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .lean(),
    LedgerLine.countDocuments(q),
  ]);
  lines = await enrichLedgerLinesWithEventType(lines);

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
