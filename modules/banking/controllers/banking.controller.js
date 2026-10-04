import catchAsync from "../../../utility/catchAsync.js";
import { registerWithIcici, getLatestRegistration } from "../services/iciciRegistration.service.js";
import { fetchAndStoreCorporateStatement } from "../services/iciciCorporateStatement.service.js";
import { fetchTransactionStatus } from "../services/iciciCorporateStatus.service.js";
import { fetchAccountBalance } from "../services/iciciBalance.service.js";
import { runEnhancedReconciliation } from "../services/reconciliationEngine.service.js";
import {
  listOpenSuspense,
  resolveSuspense,
  linkSuspenseToPayment,
} from "../services/suspense.service.js";
import { findDuplicateByComposite } from "../services/duplicateDetection.service.js";
import {
  listStatementEntries,
  listStatementAccounts,
  markStatementVerified,
  importStatementRows,
  matchPendingToStatement,
} from "../services/bankStatement.service.js";
import { checkPaymentAgainstBank } from "../services/paymentBankCheck.service.js";
import {
  createCashDeposit,
  listCashDeposits,
  verifyCashDeposit,
} from "../services/cashDeposit.service.js";
import {
  getUnclearedPayments,
  getPaymentsForApproval,
} from "../../../services/paymentReconciliationService.js";
import { encryptPayload, decryptPayload } from "../crypto/rsaEncryption.js";
import { loadKeyMaterial, getPublicKeyFingerprint } from "../crypto/keyManager.js";
import { getIciciCorporateConfig } from "../config/iciciCorporate.config.js";
import { fetchAndStoreBankStatement } from "../../../services/iciciStatement.service.js";

/** POST /api/banking/icici/register */
export const postRegister = catchAsync(async (req, res) => {
  const result = await registerWithIcici({ userId: req.user?._id });
  return res.status(200).json({ success: true, data: result });
});

/** GET /api/banking/icici/registration */
export const getRegistration = catchAsync(async (req, res) => {
  const reg = await getLatestRegistration();
  return res.status(200).json({ success: true, data: reg });
});

/** POST /api/banking/icici/statement */
export const postStatement = catchAsync(async (req, res) => {
  const { fromDate, toDate } = req.body || {};
  if (!fromDate || !toDate) {
    return res.status(400).json({ success: false, message: "fromDate and toDate required" });
  }

  const cfg = getIciciCorporateConfig();
  try {
    const result =
      cfg.useHttp && !cfg.useStub
        ? await fetchAndStoreCorporateStatement(fromDate, toDate, req.user?._id)
        : await fetchAndStoreBankStatement(fromDate, toDate);

    const { entries, ...summary } = result || {};
    return res.status(200).json({
      success: true,
      ...summary,
      fetched: Array.isArray(entries) ? entries.length : 0,
    });
  } catch (err) {
    if (err.code === "ICICI_DECRYPT_KEY_MISMATCH") {
      return res.status(502).json({
        success: false,
        code: err.code,
        message:
          "ICICI sandbox replied with a statement, but encrypted it to a different certificate than keys/public.crt (CN=erp-icici-banking). Send that certificate to ICICI to register, then Sync will load the lines.",
      });
    }
    throw err;
  }
});

/** GET /api/banking/icici/balance */
export const getBalance = catchAsync(async (req, res) => {
  const data = await fetchAccountBalance(req.user?._id);
  return res.status(200).json({ success: true, data });
});

/** GET /api/banking/icici/status */
export const getTxnStatus = catchAsync(async (req, res) => {
  const { utr, merchantTranId, amount } = req.query || {};
  const data = await fetchTransactionStatus({
    utr,
    merchantTranId,
    amount,
    userId: req.user?._id,
  });
  return res.status(200).json({ success: true, data });
});

/** POST /api/banking/reconcile */
export const postReconcileEnhanced = catchAsync(async (req, res) => {
  const { dateFrom, dateTo, source } = req.body || {};
  if (!dateFrom || !dateTo) {
    return res.status(400).json({ success: false, message: "dateFrom and dateTo required" });
  }
  const result = await runEnhancedReconciliation(dateFrom, dateTo, {
    source: source || "all",
    userId: req.user?._id,
  });
  return res.status(200).json({ success: true, ...result });
});

/** GET /api/banking/suspense */
export const getSuspense = catchAsync(async (req, res) => {
  const limit = Number(req.query.limit || 100);
  const skip = Number(req.query.skip || 0);
  const data = await listOpenSuspense({ limit, skip });
  return res.status(200).json({ success: true, data, count: data.length });
});

/** POST /api/banking/suspense/:id/resolve */
export const postResolveSuspense = catchAsync(async (req, res) => {
  const { resolutionNotes, action } = req.body || {};
  const result = await resolveSuspense(req.params.id, {
    resolutionNotes,
    action,
    userId: req.user?._id,
  });
  if (!result.ok) return res.status(404).json({ success: false, message: result.error });
  return res.status(200).json({ success: true, data: result.entry });
});

/** POST /api/banking/payments/verify — on-demand bank check for one payment */
export const postVerifyPayment = catchAsync(async (req, res) => {
  const { source, orderMongoId, paymentId, allowLiveLookup } = req.body || {};
  if (!source || !orderMongoId || !paymentId) {
    return res.status(400).json({
      success: false,
      message: "source, orderMongoId and paymentId are required",
    });
  }

  const result = await checkPaymentAgainstBank({
    source,
    orderMongoId,
    paymentId,
    userId: req.user?._id,
    allowLiveLookup: allowLiveLookup !== false,
  });

  if (!result.ok) {
    const status = result.code === "ICICI_UNREACHABLE" ? 502 : 400;
    return res.status(status).json({ success: false, message: result.error, code: result.code });
  }
  return res.status(200).json({ success: true, data: result });
});

/** GET /api/banking/payments/pending */
export const getPendingPayments = catchAsync(async (req, res) => {
  const { dateFrom, dateTo, source, limit, skip } = req.query || {};
  const all = await getUnclearedPayments({ dateFrom, dateTo, source: source || "all" });
  all.sort((a, b) => {
    const tb = new Date(b.paymentDate).getTime();
    const ta = new Date(a.paymentDate).getTime();
    const byDate = (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
    if (byDate !== 0) return byDate;
    return String(b.paymentId || "").localeCompare(String(a.paymentId || ""));
  });

  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const offset = Math.max(Number(skip) || 0, 0);
  const slice = all.slice(offset, offset + pageSize);
  const data = await matchPendingToStatement(slice);

  return res.status(200).json({
    success: true,
    data,
    count: data.length,
    total: all.length,
    limit: pageSize,
    skip: offset,
    hasMore: offset + data.length < all.length,
  });
});

/** GET /api/banking/payments/verified */
export const getVerifiedPayments = catchAsync(async (req, res) => {
  const { dateFrom, dateTo, source } = req.query || {};
  const data = await getPaymentsForApproval({ dateFrom, dateTo, source: source || "all" });
  return res.status(200).json({ success: true, data, count: data.length });
});

/** GET /api/banking/statement */
export const getStatement = catchAsync(async (req, res) => {
  const { accountNumber, dateFrom, dateTo, limit, skip } = req.query || {};
  if (!dateFrom || !dateTo) {
    return res.status(400).json({ success: false, message: "dateFrom and dateTo required" });
  }
  const page = await listStatementEntries({ accountNumber, dateFrom, dateTo, limit, skip });
  return res.status(200).json({
    success: true,
    data: page.items,
    count: page.items.length,
    total: page.total,
    limit: page.limit,
    skip: page.skip,
    hasMore: page.hasMore,
  });
});

/** GET /api/banking/statement/accounts */
export const getStatementAccounts = catchAsync(async (req, res) => {
  const data = await listStatementAccounts();
  return res.status(200).json({ success: true, data });
});

/** POST /api/banking/statement/import — load a statement exported from net banking */
export const postImportStatement = catchAsync(async (req, res) => {
  const { csv, rows, accountNumber } = req.body || {};
  if (!csv && !Array.isArray(rows)) {
    return res.status(400).json({ success: false, message: "csv or rows required" });
  }

  const result = await importStatementRows({
    csv,
    rows,
    accountNumber,
    userId: req.user?._id,
  });

  if (!result.ok) return res.status(400).json({ success: false, message: result.error });
  return res.status(200).json({ success: true, data: result });
});

/** POST /api/banking/statement/:id/verify */
export const postVerifyStatementLine = catchAsync(async (req, res) => {
  const result = await markStatementVerified(req.params.id, { userId: req.user?._id });
  if (!result.ok) return res.status(404).json({ success: false, message: result.error });
  return res.status(200).json({
    success: true,
    data: result.entry,
    alreadyVerified: result.alreadyVerified,
  });
});

/** POST /api/banking/suspense/:id/link */
export const postLinkSuspense = catchAsync(async (req, res) => {
  const { source, orderMongoId, paymentId, resolutionNotes } = req.body || {};
  const result = await linkSuspenseToPayment(req.params.id, {
    source,
    orderMongoId,
    paymentId,
    resolutionNotes,
    userId: req.user?._id,
  });
  if (!result.ok) return res.status(400).json({ success: false, message: result.error });
  return res.status(200).json({ success: true, data: result.entry });
});

/** POST /api/banking/cash-deposit */
export const postCashDeposit = catchAsync(async (req, res) => {
  const { entryDate, amount, accountNumber, slipNumber, narration } = req.body || {};
  const result = await createCashDeposit({
    entryDate,
    amount,
    accountNumber,
    slipNumber,
    narration,
    userId: req.user?._id,
  });
  if (!result.ok) return res.status(400).json({ success: false, message: result.error });
  return res.status(201).json({ success: true, data: result.deposit });
});

/** GET /api/banking/cash-deposit */
export const getCashDeposits = catchAsync(async (req, res) => {
  const { accountNumber, dateFrom, dateTo, verified } = req.query || {};
  const data = await listCashDeposits({
    accountNumber,
    dateFrom,
    dateTo,
    verified: verified === undefined ? undefined : verified === "true",
  });
  return res.status(200).json({ success: true, data, count: data.length });
});

/** POST /api/banking/cash-deposit/:id/verify */
export const postVerifyCashDeposit = catchAsync(async (req, res) => {
  const result = await verifyCashDeposit(req.params.id, { userId: req.user?._id });
  if (!result.ok) return res.status(404).json({ success: false, message: result.error });
  return res.status(200).json({
    success: true,
    matched: result.matched !== false,
    message: result.message,
    data: result.deposit,
    bankEntry: result.bankEntry || null,
  });
});

/** GET /api/banking/duplicate-check */
export const getDuplicateCheck = catchAsync(async (req, res) => {
  const { accountNumber, utr, amount, txnDate } = req.query || {};
  const dup = await findDuplicateByComposite({ accountNumber, utr, amount, txnDate });
  return res.status(200).json({ success: true, isDuplicate: Boolean(dup), data: dup });
});

/** GET /api/banking/crypto/health — key load check (no secrets exposed) */
export const getCryptoHealth = catchAsync(async (req, res) => {
  const keys = loadKeyMaterial();
  return res.status(200).json({
    success: true,
    data: {
      privateKeyLoaded: Boolean(keys.privateKey),
      publicCertLoaded: Boolean(keys.publicCert),
      iciciPublicCertLoaded: Boolean(keys.iciciPublicCert),
      iciciCertFingerprint: getPublicKeyFingerprint(keys.iciciPublicCert),
      loadedAt: keys.loadedAt,
    },
  });
});

/** POST /api/banking/crypto/test — encrypt/decrypt round-trip (dev only) */
export const postCryptoTest = catchAsync(async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ success: false, message: "Not available in production" });
  }
  const payload = req.body?.payload || { test: true, ts: Date.now() };
  const encrypted = encryptPayload(payload);
  const decrypted = decryptPayload(encrypted);
  return res.status(200).json({ success: true, encrypted: { keys: Object.keys(encrypted) }, decrypted });
});
