import { body } from "express-validator";

const MAX_AMOUNT = Number(process.env.EAZYPAY_MAX_AMOUNT || 99999999.99);

export const generateQrValidators = [
  body("orderId")
    .exists()
    .withMessage("orderId is required")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("orderId cannot be empty")
    .isLength({ max: 128 })
    .withMessage("orderId is too long"),
  body("amount")
    .exists()
    .withMessage("amount is required")
    .isFloat({ gt: 0, max: MAX_AMOUNT })
    .withMessage(`amount must be a positive number up to ${MAX_AMOUNT}`),
];
