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
import {
  getPayoutsConfig,
  getPayoutsSummary,
  getPayouts,
  getPayoutById,
  postPayout,
  postApprovePayout,
  postRejectPayout,
  postCancelPayout,
  postRefreshPayout,
  postResendPayout,
  getBeneficiaries,
  postBeneficiary,
  postApproveBeneficiary,
  postRejectBeneficiary,
  postDisableBeneficiary,
} from "../controllers/payout.controller.js";

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

// Maker–checker payouts. Approve/reject/resend also check the checker role in the service.
router.get("/payouts/config", requirePaymentAccess, getPayoutsConfig);
router.get("/payouts/summary", requirePaymentAccess, getPayoutsSummary);
router.get("/payouts", requirePaymentAccess, getPayouts);
router.post("/payouts", requirePaymentAccess, idempotencyMiddleware, postPayout);
router.get("/payouts/:id", requirePaymentAccess, getPayoutById);
router.post("/payouts/:id/approve", requirePaymentAccess, postApprovePayout);
router.post("/payouts/:id/reject", requirePaymentAccess, postRejectPayout);
router.post("/payouts/:id/cancel", requirePaymentAccess, postCancelPayout);
router.post("/payouts/:id/refresh", requirePaymentAccess, postRefreshPayout);
router.post("/payouts/:id/resend", requirePaymentAccess, postResendPayout);

// Payee register (maker adds, a different approver activates).
router.get("/beneficiaries", requirePaymentAccess, getBeneficiaries);
router.post("/beneficiaries", requirePaymentAccess, idempotencyMiddleware, postBeneficiary);
router.post("/beneficiaries/:id/approve", requirePaymentAccess, postApproveBeneficiary);
router.post("/beneficiaries/:id/reject", requirePaymentAccess, postRejectBeneficiary);
router.post("/beneficiaries/:id/disable", requirePaymentAccess, postDisableBeneficiary);

export default router;
