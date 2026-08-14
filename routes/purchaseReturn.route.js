import express from "express";
import { check, oneOf, body } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { authenticateToken } from "../middlewares/auth.middleware.js";
import {
  createPurchaseReturn,
  downloadPurchaseReturnInvoice,
  getReturnableBatches,
  listEligiblePos,
  listEligibleSuppliers,
  listReturns,
} from "../controllers/purchaseReturn.controller.js";

const router = express.Router();
router.use(authenticateToken);

router.get("/eligible-pos", listEligiblePos);
router.get("/eligible-suppliers", listEligibleSuppliers);
router.get("/returnable-batches", getReturnableBatches);
router.get("/:id/invoice", downloadPurchaseReturnInvoice);
router.get("/", listReturns);
router.post(
  "/",
  [
    oneOf(
      [
        check("supplierId").isMongoId(),
        check("purchaseOrderId").isMongoId(),
      ],
      "supplierId or purchaseOrderId is required"
    ),
    check("batchReturns").isArray({ min: 1 }).withMessage("At least one batch return is required"),
    check("batchReturns.*.batchId").isMongoId().withMessage("Valid batch ID is required"),
    check("batchReturns.*.returnQuantity")
      .isFloat({ min: 0.01 })
      .withMessage("Return qty must be > 0"),
    body("returnReason").optional().isString(),
    body("returnNotes").optional().isString(),
  ],
  checkErrors,
  createPurchaseReturn
);

export default router;
