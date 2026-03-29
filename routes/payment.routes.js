import express from "express";
import { requirePaymentAccess } from "../middlewares/auth.middleware.js";
import {
  postReconcile,
  getUnverifiedPayments,
  getForApprovalPayments,
} from "../controllers/payment.controller.js";

const router = express.Router();

router.post("/reconcile", requirePaymentAccess, postReconcile);
router.get("/reconciliation/unverified", requirePaymentAccess, getUnverifiedPayments);
router.get("/reconciliation/for-approval", requirePaymentAccess, getForApprovalPayments);

export default router;
