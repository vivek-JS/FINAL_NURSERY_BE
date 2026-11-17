import express from "express";
import { requirePaymentAccess } from "../../../middlewares/auth.middleware.js";
import { bankingIpWhitelist } from "../middleware/ipWhitelist.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import {
  postRegister,
  getRegistration,
  getRegistrationStatus,
  postDeregister,
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
  postCancelCashDeposit,
  getCashInHand,
  getEmployeeCashBookEntries,
  postVerifyPayment,
  postConfirmPayment,
  getPendingPayments,
  getVerifiedPayments,
  getStatement,
  getStatementAccounts,
  postVerifyStatementLine,
  postImportStatement,
  getCryptoHealth,
  postCryptoTest,
} from "../controllers/banking.controller.js";
import { postCorrectPaymentUtr } from "../controllers/paymentUtrCorrection.controller.js";
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
  postRefreshPayoutNeft,
  getNeftStatus,
  postRegisterBeneficiaryAtBank,
  postValidateBeneficiaryAtBank,
  postBeneValidate,
  getBeneficiaries,
  postBeneficiary,
  postApproveBeneficiary,
  postRejectBeneficiary,
  postDisableBeneficiary,
  postBulkPayouts,
  postBulkApprovePayouts,
  postBulkRejectPayouts,
  postBulkBeneficiaries,
  postBulkApproveBeneficiaries,
  postBulkRejectBeneficiaries,
} from "../controllers/payout.controller.js";

const router = express.Router();

router.use(bankingIpWhitelist);

router.get("/crypto/health", requirePaymentAccess, getCryptoHealth);
router.post("/crypto/test", requirePaymentAccess, postCryptoTest);

router.post("/icici/register", requirePaymentAccess, idempotencyMiddleware, postRegister);
router.get("/icici/registration", requirePaymentAccess, getRegistration);
router.get("/icici/registration/status", requirePaymentAccess, getRegistrationStatus);
router.post("/icici/deregister", requirePaymentAccess, idempotencyMiddleware, postDeregister);
router.get("/icici/neft-status", requirePaymentAccess, getNeftStatus);
router.post("/icici/bene-validate", requirePaymentAccess, postBeneValidate);
router.post("/icici/statement", requirePaymentAccess, idempotencyMiddleware, postStatement);
router.get("/icici/balance", requirePaymentAccess, getBalance);
router.get("/icici/status", requirePaymentAccess, getTxnStatus);

router.post("/payments/verify", requirePaymentAccess, idempotencyMiddleware, postVerifyPayment);
router.post("/payments/confirm", requirePaymentAccess, idempotencyMiddleware, postConfirmPayment);
router.post("/payments/correct-utr", requirePaymentAccess, postCorrectPaymentUtr);
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
router.post("/cash-deposit/:id/cancel", requirePaymentAccess, postCancelCashDeposit);
router.get("/cashbook/cash-in-hand", requirePaymentAccess, getCashInHand);
router.get("/cashbook/cash-in-hand/:employeeId", requirePaymentAccess, getEmployeeCashBookEntries);

router.get("/duplicate-check", requirePaymentAccess, getDuplicateCheck);

// Maker–checker payouts. Approve/reject/resend also check the checker role in the service.
router.get("/payouts/config", requirePaymentAccess, getPayoutsConfig);
router.get("/payouts/summary", requirePaymentAccess, getPayoutsSummary);
router.get("/payouts", requirePaymentAccess, getPayouts);
router.post("/payouts", requirePaymentAccess, idempotencyMiddleware, postPayout);
router.post("/payouts/bulk", requirePaymentAccess, postBulkPayouts);
router.post("/payouts/bulk-approve", requirePaymentAccess, postBulkApprovePayouts);
router.post("/payouts/bulk-reject", requirePaymentAccess, postBulkRejectPayouts);
router.get("/payouts/:id", requirePaymentAccess, getPayoutById);
router.post("/payouts/:id/approve", requirePaymentAccess, postApprovePayout);
router.post("/payouts/:id/reject", requirePaymentAccess, postRejectPayout);
router.post("/payouts/:id/cancel", requirePaymentAccess, postCancelPayout);
router.post("/payouts/:id/refresh", requirePaymentAccess, postRefreshPayout);
router.post("/payouts/:id/resend", requirePaymentAccess, postResendPayout);
router.post("/payouts/:id/neft-status", requirePaymentAccess, postRefreshPayoutNeft);

// Payee register (maker adds, a different approver activates).
router.get("/beneficiaries", requirePaymentAccess, getBeneficiaries);
router.post("/beneficiaries", requirePaymentAccess, idempotencyMiddleware, postBeneficiary);
router.post("/beneficiaries/bulk", requirePaymentAccess, postBulkBeneficiaries);
router.post("/beneficiaries/bulk-approve", requirePaymentAccess, postBulkApproveBeneficiaries);
router.post("/beneficiaries/bulk-reject", requirePaymentAccess, postBulkRejectBeneficiaries);
router.post("/beneficiaries/:id/approve", requirePaymentAccess, postApproveBeneficiary);
router.post("/beneficiaries/:id/reject", requirePaymentAccess, postRejectBeneficiary);
router.post("/beneficiaries/:id/disable", requirePaymentAccess, postDisableBeneficiary);
router.post("/beneficiaries/:id/register-bank", requirePaymentAccess, postRegisterBeneficiaryAtBank);
router.post("/beneficiaries/:id/validate", requirePaymentAccess, postValidateBeneficiaryAtBank);

export default router;
