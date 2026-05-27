import catchAsync from "../../../utility/catchAsync.js";
import generateResponse from "../../../utility/responseFormat.js";
import AppError from "../../../utility/appError.js";
import { seedChartOfAccounts } from "../coa/seedChartOfAccounts.js";
import { emitFinancialEvent } from "../events/emitFinancialEvent.js";
import { reverseJournal } from "../posting/reverseJournal.js";
import { closeFiscalPeriod } from "../posting/fiscalPeriod.js";
import { runShadowReconciliation } from "../reconciliation/shadowReconcile.js";
import {
  getPartyStatement,
  getTrialBalance,
  getAccountBook,
  getLedgerLinesList,
} from "../reports/ledgerReports.js";
import {
  getReplayJobStatus,
  startSubLedgerReplayJob,
} from "../integration/financeReplayJob.js";
import { JournalBuilder } from "../posting/journalBuilder.js";
import { createAndPostVoucher } from "../posting/postJournal.js";
import { generateVoucherNo } from "../posting/voucherNumber.js";
import { VOUCHER_TYPES } from "../domain/constants.js";
import JournalEntry from "../ledger/models/journalEntry.model.js";

export const postSeedChart = catchAsync(async (req, res) => {
  const result = await seedChartOfAccounts();
  return res.status(200).json(generateResponse("Success", "Chart of accounts seeded", result));
});

export const postReconcileShadow = catchAsync(async (req, res) => {
  const result = await runShadowReconciliation({
    sampleLimit: Number(req.body?.sampleLimit) || 200,
  });
  return res.status(200).json(generateResponse("Success", "Shadow reconciliation complete", result));
});

export const getPartyStatementReport = catchAsync(async (req, res, next) => {
  const { partyType, partyId, accountCode, startDate, endDate, includeTransfers } = req.query;
  if (!partyType || !partyId) {
    return next(new AppError("partyType and partyId are required", 400));
  }
  const data = await getPartyStatement({
    partyType,
    partyId,
    accountCode,
    startDate,
    endDate,
    includeTransfers: includeTransfers === "true" || includeTransfers === "1",
  });
  return res.status(200).json(generateResponse("Success", "Party statement", data));
});

export const getTrialBalanceReport = catchAsync(async (req, res) => {
  const { startDate, endDate, branchId } = req.query;
  const data = await getTrialBalance({ startDate, endDate, branchId });
  return res.status(200).json(generateResponse("Success", "Trial balance", data));
});

export const getCashbookReport = catchAsync(async (req, res) => {
  const { startDate, endDate } = req.query;
  const data = await getAccountBook({
    accountCode: "CASH",
    startDate,
    endDate,
  });
  return res.status(200).json(generateResponse("Success", "Cashbook", data));
});

export const getBankbookReport = catchAsync(async (req, res) => {
  const { startDate, endDate } = req.query;
  const data = await getAccountBook({
    accountCode: "BANK_ICICI",
    startDate,
    endDate,
  });
  return res.status(200).json(generateResponse("Success", "Bankbook", data));
});

export const postManualVoucher = catchAsync(async (req, res) => {
  const { voucherType, entryDate, description, lines, idempotencyKey } = req.body || {};
  if (!Array.isArray(lines) || lines.length < 2) {
    return next(new AppError("At least two journal lines required", 400));
  }
  if (!idempotencyKey) {
    return next(new AppError("idempotencyKey is required", 400));
  }

  const b = new JournalBuilder();
  for (const l of lines) {
    b.addLine(l);
  }
  b.assertBalanced();

  const vType = voucherType || VOUCHER_TYPES.JOURNAL;
  const voucherNo = await generateVoucherNo(vType);
  const result = await createAndPostVoucher({
    voucherDraft: {
      tenantId: "default",
      voucherNo,
      voucherType: vType,
      status: "DRAFT",
      branchId: "default",
      entryDate: entryDate ? new Date(entryDate) : new Date(),
      description: description || "Manual voucher",
      sourceDomain: "Manual",
      createdBy: req.user?._id,
    },
    lines: b.lines,
  });

  return res.status(201).json(
    generateResponse("Success", "Voucher posted", {
      voucher: result.voucher,
      journalEntry: result.journalEntry,
    })
  );
});

export const postReverseJournal = catchAsync(async (req, res) => {
  const { journalEntryId } = req.params;
  const { reason } = req.body || {};
  const result = await reverseJournal({
    journalEntryId,
    reason,
    postedBy: req.user?._id,
  });
  return res.status(200).json(generateResponse("Success", "Journal reversed", result));
});

export const postCloseFiscalPeriod = catchAsync(async (req, res) => {
  const { periodKey } = req.body || {};
  if (!periodKey) return next(new AppError("periodKey required (YYYY-MM)", 400));
  const period = await closeFiscalPeriod(periodKey, req.user?._id);
  return res.status(200).json(generateResponse("Success", "Period closed", period));
});

export const postFinancialEvent = catchAsync(async (req, res) => {
  const result = await emitFinancialEvent({
    ...req.body,
    createdBy: req.user?._id,
    strict: true,
  });
  return res.status(201).json(generateResponse("Success", "Financial event processed", result));
});

export const getLedgerSummary = catchAsync(async (req, res) => {
  const { accountCode, startDate, endDate } = req.query;
  const data = await getAccountBook({ accountCode, startDate, endDate });
  return res.status(200).json(generateResponse("Success", "Ledger summary", data));
});

export const getLedgerLinesReport = catchAsync(async (req, res) => {
  const {
    partyType,
    partyId,
    accountCode,
    startDate,
    endDate,
    page,
    limit,
  } = req.query;
  const data = await getLedgerLinesList({
    partyType,
    partyId,
    accountCode,
    startDate,
    endDate,
    page,
    limit,
  });
  return res.status(200).json(generateResponse("Success", "Ledger lines", data));
});

export const postReplaySubLedgers = catchAsync(async (req, res) => {
  const { sources, since, until } = req.body || {};
  const result = await startSubLedgerReplayJob(
    {
      sources: Array.isArray(sources)
        ? sources
        : typeof sources === "string"
          ? sources.split(",").map((s) => s.trim())
          : undefined,
      since,
      until,
    },
    req.user?._id
  );
  const message = result.alreadyRunning
    ? "Central ledger sync is already running"
    : "Central ledger sync started";
  return res.status(result.alreadyRunning ? 409 : 202).json(
    generateResponse(result.alreadyRunning ? "Conflict" : "Success", message, result)
  );
});

export const getReplaySubLedgersStatus = catchAsync(async (req, res) => {
  const job = getReplayJobStatus();
  return res.status(200).json(generateResponse("Success", "Replay job status", job));
});
