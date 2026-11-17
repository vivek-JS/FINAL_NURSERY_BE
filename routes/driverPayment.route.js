import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { authorizeRoles } from "../middlewares/auth.middleware.js";
import { listPayments, addPay } from "../controllers/driverPayment.controller.js";

const router = express.Router();
const ACCOUNT = ["ACCOUNTANT", "SUPER_ADMIN", "SUPERADMIN", "ADMIN"];

router.get("/", authorizeRoles(ACCOUNT), listPayments);
router.post(
  "/:id/pay",
  authorizeRoles(ACCOUNT),
  [check("id").isMongoId().withMessage("Invalid driver payment id"), checkErrors],
  addPay
);

export default router;
