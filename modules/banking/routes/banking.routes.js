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

router.post("/reconcile", requirePaymentAccess, idempotencyMiddleware, postReconcileEnhanced);
router.get("/suspense", requirePaymentAccess, getSuspense);
router.post("/suspense/:id/resolve", requirePaymentAccess, postResolveSuspense);
router.get("/duplicate-check", requirePaymentAccess, getDuplicateCheck);

export default router;
