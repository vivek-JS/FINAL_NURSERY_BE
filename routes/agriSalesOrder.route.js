import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import multer from "multer";
import mongoose from "mongoose";
import {
  createAgriSalesOrder,
  createLinkedAgriOrderFromNurseryOrder,
  updateAgriSalesOrder,
  acceptAgriSalesOrder,
  rejectAgriSalesOrder,
  cancelAgriSalesOrder,
  getAllAgriSalesOrders,
  getAgriSalesOrderById,
  addPaymentToAgriSalesOrder,
  generatePaymentQRAgri,
  updatePaymentStatus,
  getCustomerByMobile,
  getPendingPayments,
  getPendingPaymentsCount,
  getOutstandingAnalysis,
  getCustomerOutstanding,
  getOutstandingAgriSalesOrders,
  assignOrdersToSalesPerson,
  getAssignedOrders,
  cancelAssignment,
  dispatchOrders,
  updateDispatchStatus,
  completeOrders,
  processSalesReturn,
  getOrdersForDispatch,
  getDispatchedOrders,
  markLinkedAgriLoaded,
  getLinkedOrdersByNurseryOrder,
  getTodayPendingLinkedLoads,
  getDispatchLoadStatus,
  getRamAgriOutstandingLimitSummary,
  getRamAgriOutstandingLimitSettings,
  patchRamAgriOutstandingLimitGlobal,
  patchRamAgriOutstandingLimitUser,
} from "../controllers/agriSalesOrder.controller.js";
import { getAgriOrderTimeline } from "../modules/orderEvents/api/orderEvents.controller.js";
import {
  getAgriOrderBatchSummary,
  requestAgriSalesReturn,
  listAgriSalesReturnRequests,
  approveAgriSalesReturnRequest,
  rejectAgriSalesReturnRequest,
  getAgriSalesReturnRequestsForOrder,
} from "../controllers/agriSalesReturnRequest.controller.js";

const router = express.Router();

/** POST /create — multi-line payloads put qty/rate/product on each `lineItems[]` entry, not on the root body. */
function agriCreateHasLineItems(req) {
  return Array.isArray(req.body?.lineItems) && req.body.lineItems.length > 0;
}

/** Accept YYYY-MM-DD, full ISO (± offset / Z), or DD-MM-YYYY from clients. */
function isValidAgriCalendarDate(value) {
  if (value === null || value === undefined || value === "") return true;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== "string") return !Number.isNaN(Date.parse(value));
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [y, m, d] = trimmed.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    return (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === m - 1 &&
      dt.getUTCDate() === d
    );
  }
  if (!Number.isNaN(Date.parse(trimmed))) return true;
  const dmy = trimmed.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    const dt = new Date(year, month - 1, day);
    return (
      dt.getFullYear() === year &&
      dt.getMonth() === month - 1 &&
      dt.getDate() === day
    );
  }
  return false;
}

function agriDeliveryDateCheck() {
  return check("deliveryDate")
    .optional({ nullable: true, checkFalsy: true })
    .custom((value) => {
      if (!isValidAgriCalendarDate(value)) {
        throw new Error("Invalid delivery date format");
      }
      return true;
    });
}

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

// ==================== ASSIGNMENT ROUTES ====================
router.get("/assigned", getAssignedOrders); // Get orders assigned to sales person
router.patch(
  "/assign",
  [
    check("orderIds").isArray({ min: 1 }).withMessage("At least one order ID is required"),
    check("orderIds.*").isMongoId().withMessage("All order IDs must be valid"),
    check("assignToUserId").isMongoId().withMessage("Valid sales person ID is required"),
    check("assignmentNotes").optional().isString(),
  ],
  checkErrors,
  assignOrdersToSalesPerson
);
router.patch(
  "/:id/cancel-assignment",
  [
    check("id").isMongoId().withMessage("Valid order ID is required"),
    check("reason").optional().isString(),
  ],
  checkErrors,
  cancelAssignment
);

// ==================== DISPATCH ROUTES ====================
router.get("/dispatch/pending", getOrdersForDispatch); // Get orders ready for dispatch
router.get("/dispatch/history", getDispatchedOrders); // Get dispatched orders
router.post("/linked/dispatch-load-status", getDispatchLoadStatus);
router.patch(
  "/dispatch",
  [
    check("orderIds").isArray({ min: 1 }).withMessage("At least one order ID is required"),
    check("orderIds.*").isMongoId().withMessage("All order IDs must be valid"),
    check("dispatchMode")
      .optional()
      .isIn(["VEHICLE", "COURIER", "WITH_ORDER", "OFFICE"])
      .withMessage("Dispatch mode must be VEHICLE, COURIER, WITH_ORDER, or OFFICE"),
    // Vehicle mode validations (optional - validated in controller based on mode)
    check("driverName").optional(),
    check("driverMobile").optional(),
    check("vehicleNumber").optional(),
    // Courier mode validations (optional - validated in controller based on mode)
    check("courierName").optional(),
    check("courierTrackingId").optional(),
    check("courierContact").optional(),
  ],
  checkErrors,
  dispatchOrders
);
router.patch(
  "/:id/dispatch-status",
  [
    check("id").isMongoId().withMessage("Valid order ID is required"),
    check("dispatchStatus")
      .isIn(["IN_TRANSIT", "DELIVERED", "NOT_DISPATCHED"])
      .withMessage("Invalid dispatch status"),
  ],
  checkErrors,
  updateDispatchStatus
);

// ==================== COMPLETE ORDERS (Mark as Delivered with Return Handling) ====================
router.patch(
  "/complete",
  [
    check("orderIds").isArray({ min: 1 }).withMessage("At least one order ID is required"),
    check("orderIds.*").isMongoId().withMessage("All order IDs must be valid"),
    check("returnQuantities").optional().isObject().withMessage("Return quantities must be an object"),
    check("returnReason").optional().isString().withMessage("Return reason must be a string"),
    check("returnNotes").optional().isString().withMessage("Return notes must be a string"),
  ],
  checkErrors,
  completeOrders
);

// ==================== SALES RETURN (For Sales Person Dispatched Orders - NO Stock Impact) ====================
router.patch(
  "/:id/sales-return",
  [
    check("id").isMongoId().withMessage("Valid order ID is required"),
    check("returnQuantity").isNumeric().withMessage("Return quantity must be a number").isFloat({ min: 0 }).withMessage("Return quantity must be >= 0"),
    check("returnReason").optional().isString().withMessage("Return reason must be a string"),
    check("returnNotes").optional().isString().withMessage("Return notes must be a string"),
    check("paymentAdjustments").optional().isArray().withMessage("Payment adjustments must be an array"),
    check("paymentAdjustments.*.amount").optional().isNumeric().withMessage("Payment adjustment amount must be a number"),
    check("paymentAdjustments.*.adjustmentType").optional().isIn(["REFUND", "CREDIT", "ADJUSTMENT", "DEDUCTION"]).withMessage("Invalid adjustment type"),
    check("paymentAdjustments.*.reason").optional().isString().withMessage("Adjustment reason must be a string"),
    check("paymentAdjustments.*.notes").optional().isString().withMessage("Adjustment notes must be a string"),
  ],
  checkErrors,
  processSalesReturn
);

// ==================== SALES RETURN REQUESTS (Dealer submit → Office approve) ====================
router.post(
  "/returns/request",
  [
    check("orderId").isMongoId().withMessage("Valid order ID is required"),
    check("lineReturns").isArray({ min: 1 }).withMessage("At least one line return is required"),
  ],
  checkErrors,
  requestAgriSalesReturn
);
router.get("/returns", listAgriSalesReturnRequests);
router.patch("/returns/:id/approve", approveAgriSalesReturnRequest);
router.patch("/returns/:id/reject", rejectAgriSalesReturnRequest);
router.get("/returns/by-order/:orderId", getAgriSalesReturnRequestsForOrder);

// ==================== ORDER ROUTES ====================
router
  .post(
    "/linked/create",
    [
      check("linkedNurseryOrderId").isMongoId().withMessage("Valid linked nursery order ID is required"),
      check("ramAgriCropId")
        .optional({ values: "null" })
        .isMongoId()
        .withMessage("Valid crop ID is required when productId is not used"),
      check("ramAgriVarietyId")
        .optional({ values: "null" })
        .isMongoId()
        .withMessage("Valid variety ID is required when productId is not used"),
      check("productId")
        .optional({ values: "null" })
        .isMongoId()
        .withMessage("Valid gift product ID is required when Ram Agri crop is not used"),
      check("quantity").isNumeric().withMessage("Quantity must be numeric").isFloat({ min: 0.01 }).withMessage("Quantity must be > 0"),
      check("rate").optional().isNumeric().withMessage("Rate must be numeric"),
    ],
    checkErrors,
    createLinkedAgriOrderFromNurseryOrder
  )
  .get("/linked/by-nursery-order/:orderId", getLinkedOrdersByNurseryOrder)
  .get("/linked/today-pending-load", getTodayPendingLinkedLoads)
  .patch(
    "/linked/:id/mark-loaded",
    [check("id").isMongoId().withMessage("Valid agri order ID is required")],
    checkErrors,
    markLinkedAgriLoaded
  )
  .post(
    "/create",
    [
      check("customerName").notEmpty().withMessage("Customer name is required"),
      check("customerMobile")
        .isLength({ min: 10, max: 10 })
        .withMessage("Mobile number must be exactly 10 digits")
        .matches(/^\d{10}$/)
        .withMessage("Mobile number must contain only digits"),
      // productId is only required for regular single-line creates (not Ram Agri, not multi-line).
      check("productId")
        .custom((value, { req }) => {
          if (agriCreateHasLineItems(req)) return true;
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
      // Ram Agri product fields - required on root only for single-line Ram Agri creates
      check("ramAgriCropId")
        .custom((value, { req }) => {
          if (agriCreateHasLineItems(req)) return true;
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
          if (agriCreateHasLineItems(req)) return true;
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
      check("quantity")
        .custom((value, { req }) => {
          if (agriCreateHasLineItems(req)) return true;
          if (value === undefined || value === null || value === "") {
            throw new Error("Quantity is required");
          }
          const qty = Number(value);
          if (Number.isNaN(qty) || qty <= 0) {
            throw new Error("Quantity must be greater than 0");
          }
          return true;
        }),
      check("rate")
        .custom((value, { req }) => {
          if (agriCreateHasLineItems(req)) return true;
          if (req.body.isRamAgriProduct === true && (value === undefined || value === null || value === "")) {
            return true;
          }
          if (value === undefined || value === null || value === "") {
            throw new Error("Rate is required");
          }
          const numeric = Number(value);
          if (Number.isNaN(numeric) || numeric < 0) {
            throw new Error("Rate must be a non-negative number");
          }
          return true;
        }),
      check("orderDate").optional().isISO8601().withMessage("Invalid order date format"),
      agriDeliveryDateCheck(),
    ],
    checkErrors,
    createAgriSalesOrder
  )
  .get("/outstanding", getOutstandingAgriSalesOrders)
  .get("/outstanding-limit/summary", getRamAgriOutstandingLimitSummary)
  .get("/outstanding-limit/settings", getRamAgriOutstandingLimitSettings)
  .patch(
    "/outstanding-limit/global",
    [
      check("defaultOutstandingLimitRupees")
        .isNumeric()
        .withMessage("defaultOutstandingLimitRupees must be numeric")
        .isFloat({ min: 0 })
        .withMessage("defaultOutstandingLimitRupees must be >= 0"),
    ],
    checkErrors,
    patchRamAgriOutstandingLimitGlobal
  )
  .patch(
    "/outstanding-limit/user/:userId",
    [
      check("userId").isMongoId().withMessage("Valid user ID is required"),
      check("ramAgriOutstandingLimitRupees")
        .optional({ nullable: true })
        .custom((value) => {
          if (value === null || value === undefined || value === "") return true;
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0) {
            throw new Error("ramAgriOutstandingLimitRupees must be null or a non-negative number");
          }
          return true;
        }),
    ],
    checkErrors,
    patchRamAgriOutstandingLimitUser
  )
  .get("/", getAllAgriSalesOrders)
  .get("/:id/timeline", getAgriOrderTimeline)
  .get("/:id/batch-summary", getAgriOrderBatchSummary)
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
      agriDeliveryDateCheck(),
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
  .post("/:id/generate-payment-qr", [check("id").isMongoId().withMessage("Valid order ID is required")], checkErrors, generatePaymentQRAgri)
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
      check("paymentStatus").isIn(["COLLECTED", "REJECTED", "PENDING", "BANK_VERIFIED"]).withMessage("Invalid payment status"),
    ],
    checkErrors,
    updatePaymentStatus
  );

export default router;

