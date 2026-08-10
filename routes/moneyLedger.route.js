import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { authenticateToken } from "../middlewares/auth.middleware.js";
import {
  listBooks,
  listParties,
  getPartyStatement,
  addPayment,
  addPartyDiscount,
  addDocumentScopedPayment,
  runBackfill,
} from "../controllers/moneyLedger.controller.js";

const router = express.Router();
router.use(authenticateToken);

router.get("/books", listBooks);
router.get("/parties", listParties);
router.get("/parties/:partyType/:partyId", getPartyStatement);
router.post(
  "/payments",
  [
    check("amount").isFloat({ min: 0.01 }).withMessage("amount must be > 0"),
  ],
  checkErrors,
  addPayment
);
router.post(
  "/discounts",
  [
    check("partyType").notEmpty().withMessage("partyType is required"),
    check("partyId").isMongoId().withMessage("Valid partyId is required"),
    check("amount").isFloat({ min: 0.01 }).withMessage("amount must be > 0"),
  ],
  checkErrors,
  addPartyDiscount
);
router.post(
  "/documents/:type/:id/payments",
  [check("amount").isFloat({ min: 0.01 }).withMessage("amount must be > 0")],
  checkErrors,
  addDocumentScopedPayment
);
router.post("/backfill", runBackfill);

export default router;
