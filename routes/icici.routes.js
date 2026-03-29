import express from "express";
import { generateQr, getIciciPaymentStatus } from "../controllers/icici.controller.js";
import { generateQrValidators } from "../utils/iciciValidation.js";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { postBankStatement } from "../controllers/payment.controller.js";
import { requirePaymentAccess } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.post("/qr", generateQrValidators, checkErrors, generateQr);
router.post("/bank-statement", requirePaymentAccess, postBankStatement);
router.get("/status/:merchantTranId", getIciciPaymentStatus);

export default router;
