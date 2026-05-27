import express from "express";
import {
  authorizeRoles,
  requirePaymentAccess,
} from "../../../middlewares/auth.middleware.js";
import {
  postSeedChart,
  postReconcileShadow,
  getPartyStatementReport,
  getTrialBalanceReport,
  getCashbookReport,
  getBankbookReport,
  postManualVoucher,
  postReverseJournal,
  postCloseFiscalPeriod,
  postFinancialEvent,
  getLedgerSummary,
  getLedgerLinesReport,
  postReplaySubLedgers,
  getReplaySubLedgersStatus,
} from "../api/finance.controller.js";

const router = express.Router();

const financeRead = [requirePaymentAccess];
const financeWrite = [
  requirePaymentAccess,
  authorizeRoles(["SUPER_ADMIN", "ADMIN", "ACCOUNTANT"]),
];

router.post("/coa/seed", ...financeWrite, postSeedChart);
router.post("/reconcile/shadow", ...financeWrite, postReconcileShadow);
router.get("/reports/party-statement", ...financeRead, getPartyStatementReport);
router.get("/reports/trial-balance", ...financeRead, getTrialBalanceReport);
router.get("/reports/cashbook", ...financeRead, getCashbookReport);
router.get("/reports/bankbook", ...financeRead, getBankbookReport);
router.get("/reports/ledger-summary", ...financeRead, getLedgerSummary);
router.get("/reports/ledger-lines", ...financeRead, getLedgerLinesReport);
router.post("/replay/subledgers", ...financeWrite, postReplaySubLedgers);
router.get("/replay/subledgers/status", ...financeRead, getReplaySubLedgersStatus);
router.post("/vouchers/manual", ...financeWrite, postManualVoucher);
router.post("/journals/:journalEntryId/reverse", ...financeWrite, postReverseJournal);
router.post("/fiscal-periods/close", ...financeWrite, postCloseFiscalPeriod);
router.post("/events", ...financeWrite, postFinancialEvent);

export default router;
