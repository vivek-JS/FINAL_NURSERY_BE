/**
 * ERP payment reconciliation — bank statement fetch + list endpoints.
 * POST /api/payments/icici/bank-statement is mounted from icici.routes.js
 */

import catchAsync from "../utility/catchAsync.js";
import { fetchAndStoreBankStatement } from "../services/iciciStatement.service.js";
import { runReconciliation } from "../services/reconciliation.service.js";
import {
  getUnclearedPayments,
  getPaymentsForApproval,
} from "../services/paymentReconciliationService.js";

/**
 * POST .../icici/bank-statement (see icici.routes)
 * Body: { fromDate, toDate } ISO or YYYY-MM-DD
 */
export const postBankStatement = catchAsync(async (req, res) => {
  const { fromDate, toDate } = req.body || {};
  if (!fromDate || !toDate) {
    return res.status(400).json({ success: false, message: "fromDate and toDate are required" });
  }
  const from = new Date(fromDate);
  const to = new Date(toDate);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return res.status(400).json({ success: false, message: "Invalid dates" });
  }
  if (from > to) {
    return res.status(400).json({ success: false, message: "fromDate must be before toDate" });
  }
  const maxDays = Number(process.env.ICICI_STATEMENT_MAX_RANGE_DAYS || 90);
  if ((to - from) / (86400000) > maxDays) {
    return res.status(400).json({
      success: false,
      message: `Date range too large (max ${maxDays} days)`,
    });
  }

  try {
    const result = await fetchAndStoreBankStatement(from, to);
    return res.status(200).json({
      success: true,
      inserted: result.inserted,
      skipped: result.skipped,
      total: result.total,
      message: result.message,
    });
  } catch (err) {
    return res.status(502).json({
      success: false,
      message: err.message || "Bank statement fetch failed",
      code: err.code,
    });
  }
});

/**
 * POST /api/payments/reconcile
 * Body: { dateFrom, dateTo, source?: 'all'|'order'|'agriSales' }
 */
export const postReconcile = catchAsync(async (req, res) => {
  const { dateFrom, dateTo, source } = req.body || {};
  if (!dateFrom || !dateTo) {
    return res.status(400).json({ success: false, message: "dateFrom and dateTo are required" });
  }
  const result = await runReconciliation(dateFrom, dateTo, source || "all");
  return res.status(200).json({ success: true, ...result });
});

/**
 * GET /api/payments/reconciliation/unverified?dateFrom=&dateTo=&source=
 */
export const getUnverifiedPayments = catchAsync(async (req, res) => {
  const { dateFrom, dateTo, source } = req.query || {};
  const list = await getUnclearedPayments({
    dateFrom,
    dateTo,
    source: source || "all",
  });
  return res.status(200).json({ success: true, data: list, count: list.length });
});

/**
 * GET /api/payments/reconciliation/for-approval?dateFrom=&dateTo=&source=
 */
export const getForApprovalPayments = catchAsync(async (req, res) => {
  const { dateFrom, dateTo, source } = req.query || {};
  const list = await getPaymentsForApproval({
    dateFrom,
    dateTo,
    source: source || "all",
  });
  return res.status(200).json({ success: true, data: list, count: list.length });
});
