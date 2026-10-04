import express from "express";
import { requirePaymentAccess } from "../../../middlewares/auth.middleware.js";
import { bankingIpWhitelist } from "../middleware/ipWhitelist.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import {
  postRegister,
  getRegistration,
  postStatement,
  getBalance,
  getTxnStatus,
  postReconcileEnhanced,
  getSuspense,
  postResolveSuspense,
  getDuplicateCheck,
  postLinkSuspense,
  postCashDeposit,
  getCashDeposits,
  postVerifyCashDeposit,
  postVerifyPayment,
  getPendingPayments,
  getVerifiedPayments,
  getStatement,
  getStatementAccounts,
  postVerifyStatementLine,
  postImportStatement,
  getCryptoHealth,
  postCryptoTest,
} from "../controllers/banking.controller.js";

const router = express.Router();

router.use(bankingIpWhitelist);

router.get("/crypto/health", requirePaymentAccess, getCryptoHealth);
router.post("/crypto/test", requirePaymentAccess, postCryptoTest);

router.post("/icici/register", requirePaymentAccess, idempotencyMiddleware, postRegister);
router.get("/icici/registration", requirePaymentAccess, getRegistration);
router.post("/icici/statement", requirePaymentAccess, idempotencyMiddleware, postStatement);
router.get("/icici/balance", requirePaymentAccess, getBalance);
router.get("/icici/status", requirePaymentAccess, getTxnStatus);

router.post("/payments/verify", requirePaymentAccess, idempotencyMiddleware, postVerifyPayment);
router.get("/payments/pending", requirePaymentAccess, getPendingPayments);
router.get("/payments/verified", requirePaymentAccess, getVerifiedPayments);

router.get("/statement", requirePaymentAccess, getStatement);
router.get("/statement/accounts", requirePaymentAccess, getStatementAccounts);
router.post("/statement/import", requirePaymentAccess, postImportStatement);
router.post("/statement/:id/verify", requirePaymentAccess, postVerifyStatementLine);

router.post("/reconcile", requirePaymentAccess, idempotencyMiddleware, postReconcileEnhanced);
router.get("/suspense", requirePaymentAccess, getSuspense);
router.post("/suspense/:id/resolve", requirePaymentAccess, postResolveSuspense);
router.post("/suspense/:id/link", requirePaymentAccess, postLinkSuspense);

router.post("/cash-deposit", requirePaymentAccess, idempotencyMiddleware, postCashDeposit);
router.get("/cash-deposit", requirePaymentAccess, getCashDeposits);
router.post("/cash-deposit/:id/verify", requirePaymentAccess, postVerifyCashDeposit);

router.get("/duplicate-check", requirePaymentAccess, getDuplicateCheck);

export default router;
