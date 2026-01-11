import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import multer from "multer";
import mongoose from "mongoose";
import {
  createAgriSalesOrder,
  updateAgriSalesOrder,
  acceptAgriSalesOrder,
  rejectAgriSalesOrder,
  cancelAgriSalesOrder,
  getAllAgriSalesOrders,
  getAgriSalesOrderById,
  addPaymentToAgriSalesOrder,
  updatePaymentStatus,
  getCustomerByMobile,
  getPendingPayments,
  getPendingPaymentsCount,
  getOutstandingAnalysis,
  getCustomerOutstanding,
} from "../controllers/agriSalesOrder.controller.js";

const router = express.Router();

// Multer for images (memory storage for Cloudinary)
const uploadImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"].includes(file.mimetype);
    cb(ok ? null : new Error("Only JPG/PNG/WEBP/AVIF/GIF allowed"), ok);
  },
});

// ==================== CUSTOMER LOOKUP ====================
router.get("/customer/:mobileNumber", getCustomerByMobile);

// ==================== PENDING PAYMENTS (FOR ACCOUNTANT) ====================
router.get("/pending-payments", getPendingPayments);
router.get("/pending-payments/count", getPendingPaymentsCount);

// ==================== OUTSTANDING ANALYSIS ====================
router.get("/outstanding-analysis", getOutstandingAnalysis);
router.get("/customer-outstanding", getCustomerOutstanding);

// ==================== ORDER ROUTES ====================
router
  .post(
    "/create",
    [
      check("customerName").notEmpty().withMessage("Customer name is required"),
      check("customerMobile")
        .isLength({ min: 10, max: 10 })
        .withMessage("Mobile number must be exactly 10 digits")
        .matches(/^\d{10}$/)
        .withMessage("Mobile number must contain only digits"),
      // productId is only required for regular products (not Ram Agri products)
      check("productId")
        .custom((value, { req }) => {
          // If isRamAgriProduct is true, productId is not required
          if (req.body.isRamAgriProduct === true) {
            return true; // Skip validation for Ram Agri products
          }
          // For regular products, productId must be present and valid MongoId
          if (!value) {
            throw new Error("Product ID is required for regular products");
          }
          if (!mongoose.Types.ObjectId.isValid(value)) {
            throw new Error("Valid product ID is required for regular products");
          }
          return true;
        }),
      // Ram Agri product fields - required if isRamAgriProduct is true
      check("ramAgriCropId")
        .custom((value, { req }) => {
          if (req.body.isRamAgriProduct === true) {
            if (!value) {
              throw new Error("Crop ID is required for Ram Agri products");
            }
            if (!mongoose.Types.ObjectId.isValid(value)) {
              throw new Error("Valid crop ID is required for Ram Agri products");
            }
          }
          return true;
        }),
      check("ramAgriVarietyId")
        .custom((value, { req }) => {
          if (req.body.isRamAgriProduct === true) {
            if (!value) {
              throw new Error("Variety ID is required for Ram Agri products");
            }
            if (!mongoose.Types.ObjectId.isValid(value)) {
              throw new Error("Valid variety ID is required for Ram Agri products");
            }
          }
          return true;
        }),
      check("quantity").isNumeric().withMessage("Quantity must be a number").isFloat({ min: 0.01 }).withMessage("Quantity must be greater than 0"),
      check("rate").isNumeric().withMessage("Rate must be a number").isFloat({ min: 0 }).withMessage("Rate must be greater than or equal to 0"),
      check("orderDate").optional().isISO8601().withMessage("Invalid order date format"),
      check("deliveryDate")
        .optional({ nullable: true, checkFalsy: false })
        .custom((value) => {
          // Allow null, undefined, or empty string
          if (value === null || value === undefined || value === "") {
            return true;
          }
          // If value exists, validate it's a valid ISO8601 date
          const dateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/;
          if (typeof value === "string" && dateRegex.test(value)) {
            return !isNaN(Date.parse(value));
          }
          return false;
        })
        .withMessage("Invalid delivery date format"),
    ],
    checkErrors,
    createAgriSalesOrder
  )
  .get("/", getAllAgriSalesOrders)
  .get("/:id", getAgriSalesOrderById)
  .patch(
    "/:id",
    [
      check("id").isMongoId().withMessage("Valid order ID is required"),
      check("customerMobile").optional().isLength({ min: 10, max: 10 }).withMessage("Mobile number must be exactly 10 digits"),
      check("productId").optional().isMongoId().withMessage("Valid product ID is required"),
      check("quantity").optional().isNumeric().withMessage("Quantity must be a number").isFloat({ min: 0.01 }).withMessage("Quantity must be greater than 0"),
      check("rate").optional().isNumeric().withMessage("Rate must be a number").isFloat({ min: 0 }).withMessage("Rate must be greater than or equal to 0"),
      check("orderDate").optional().isISO8601().withMessage("Invalid order date format"),
      check("deliveryDate").optional().isISO8601().withMessage("Invalid delivery date format"),
    ],
    checkErrors,
    updateAgriSalesOrder
  )
  .patch(
    "/:id/accept",
    [check("id").isMongoId().withMessage("Valid order ID is required")],
    checkErrors,
    acceptAgriSalesOrder
  )
  .patch(
    "/:id/reject",
    [
      check("id").isMongoId().withMessage("Valid order ID is required"),
      check("reason").optional().isString().withMessage("Reason must be a string"),
    ],
    checkErrors,
    rejectAgriSalesOrder
  )
  .patch(
    "/:id/cancel",
    [
      check("id").isMongoId().withMessage("Valid order ID is required"),
      check("reason").optional().isString().withMessage("Reason must be a string"),
    ],
    checkErrors,
    cancelAgriSalesOrder
  )
  .patch(
    "/:id/payment",
    [
      check("id").isMongoId().withMessage("Valid order ID is required"),
      check("paidAmount").isNumeric().withMessage("Paid amount must be a number").isFloat({ min: 0.01 }).withMessage("Paid amount must be greater than 0"),
      check("paymentDate").optional().isISO8601().withMessage("Invalid payment date format"),
      check("modeOfPayment").optional().isIn(["Cash", "UPI", "Cheque", "NEFT/RTGS", "1341", "434", "Wallet"]).withMessage("Invalid payment mode"),
      check("isWalletPayment").optional().isBoolean().withMessage("isWalletPayment must be a boolean"),
    ],
    checkErrors,
    addPaymentToAgriSalesOrder
  )
  .patch(
    "/:id/payment/:paymentIndex/status",
    [
      check("id").isMongoId().withMessage("Valid order ID is required"),
      check("paymentIndex").isInt({ min: 0 }).withMessage("Valid payment index is required"),
      check("paymentStatus").isIn(["COLLECTED", "REJECTED", "PENDING"]).withMessage("Invalid payment status"),
    ],
    checkErrors,
    updatePaymentStatus
  );

export default router;

