import catchAsync from "../../../utility/catchAsync.js";
import { registerWithIcici, getLatestRegistration } from "../services/iciciRegistration.service.js";
import { fetchAndStoreCorporateStatement } from "../services/iciciCorporateStatement.service.js";
import { fetchTransactionStatus } from "../services/iciciCorporateStatus.service.js";
import { fetchAccountBalance } from "../services/iciciBalance.service.js";
import { runEnhancedReconciliation } from "../services/reconciliationEngine.service.js";
import { listOpenSuspense, resolveSuspense } from "../services/suspense.service.js";
import { findDuplicateByComposite } from "../services/duplicateDetection.service.js";
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
  const result =
    cfg.useHttp && !cfg.useStub
      ? await fetchAndStoreCorporateStatement(fromDate, toDate, req.user?._id)
      : await fetchAndStoreBankStatement(fromDate, toDate);

  return res.status(200).json({ success: true, ...result });
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
