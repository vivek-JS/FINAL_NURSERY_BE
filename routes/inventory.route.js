import express from "express";
import { check } from "express-validator";
import mongoose from "mongoose";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { restrictRamAgriSalesManager } from "../middlewares/auth.middleware.js";
import {
  // Product controllers
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  deleteProduct,
  toggleProductStatus,
  
  // Batch controllers
  createBatch,
  getAllBatches,
  
  // Inward controllers
  createInward,
  getAllInwards,
  
  // Outward controllers
  createOutward,
  getAllOutwards,
  
  // Stock adjustment controllers
  createStockAdjustment,
  
  // Summary
  getInventorySummary,
  
  // Dashboard
  getInventoryDashboard,
} from "../controllers/inventory.controller.js";
import {
  createCrop,
  getAllCrops,
  getCropById,
  updateCrop,
  deleteCrop,
  addVariety,
  updateVariety,
  deleteVariety,
  addRate,
  updateRate,
  deleteRate,
} from "../controllers/ramAgriInputsProduct.controller.js";
import {
  getPendingPayments as getAgriSalesPendingPayments,
  getPendingPaymentsCount as getAgriSalesPendingPaymentsCount,
  getOutstandingAnalysis as getAgriSalesOutstandingAnalysis,
  getSalesAnalysis as getAgriSalesSalesAnalysis,
  getCustomerOutstanding as getAgriSalesCustomerOutstanding,
} from "../controllers/agriSalesOrder.controller.js";
import { getRamAgriSalesDashboard } from "../controllers/ramAgriSalesDashboard.controller.js";
import { getRamAgriSalesRankboard } from "../controllers/ramAgriSalesRankboard.controller.js";
import { getVarietyLedger, getCustomerLedger, clearCustomerLedger } from "../controllers/ramAgriLedger.controller.js";
import { getMerchantLedger } from "../controllers/ramAgriMerchantLedger.controller.js";
import { getRamAgriSalesTargets, upsertRamAgriSalesTarget } from "../controllers/ramAgriSalesTarget.controller.js";
// Import product controller for Product model (with code, primaryUnit, secondaryUnit, etc.)
import * as productController from "../controllers/product.controller.js";

const router = express.Router();

const validateObjectId = (value) => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new Error("Invalid ID format");
  }
  return true;
};

// ==================== PRODUCT ROUTES ====================

// Apply RAM_AGRI_SALES_MANAGER restriction to all routes except allowed ones
// Note: Ram Agri routes are allowed, but other inventory routes are restricted
router.use((req, res, next) => {
  // Skip restriction for Ram Agri routes (they're explicitly allowed)
  const path = req.path || req.originalUrl || '';
  const isRamAgriRoute = path.includes('ram-agri') || path === '/dashboard';
  
  if (isRamAgriRoute) {
    return next(); // Ram Agri routes are allowed, skip restriction
  }
  
  // Apply restriction for all other routes
  restrictRamAgriSalesManager(req, res, next);
});

// POST /products - Create product using Product model (supports code, primaryUnit, secondaryUnit, plantId, subtypeId, isRamAgriSales)
// This route handles products with the extended schema (used by frontend ProductForm)
router.post(
  "/products",
  [
    check("code").notEmpty().withMessage("Product code is required"),
    check("name").notEmpty().withMessage("Product name is required"),
    check("category").notEmpty().withMessage("Product category is required"),
    check("primaryUnit").notEmpty().withMessage("Primary unit is required"),
    check("secondaryUnit").optional({ nullable: true, checkFalsy: true }).custom((value) => {
      if (value === null || value === undefined || value === '') return true;
      return validateObjectId(value);
    }).withMessage("Invalid secondary unit ID"),
    check("conversionFactor").optional().isNumeric().withMessage("Conversion factor must be a number"),
    check("minStockLevel").optional().isNumeric().withMessage("Min stock level must be a number"),
    check("reorderLevel").optional().isNumeric().withMessage("Reorder level must be a number"),
    check("gst").optional().isNumeric().withMessage("GST must be a number"),
    check("isRamAgriSales").optional().isBoolean().withMessage("isRamAgriSales must be a boolean value"),
  ],
  checkErrors,
  productController.createProduct
);

// POST /products/create - Create product using InventoryProduct model (legacy route)
router
  .post(
    "/products/create",
    [
      check("name").notEmpty().withMessage("Product name is required"),
      check("category").notEmpty().withMessage("Product category is required"),
      check("unit").notEmpty().withMessage("Product unit is required"),
      check("costPrice").isNumeric().withMessage("Cost price must be a number"),
      check("minStockLevel").optional().isNumeric().withMessage("Min stock level must be a number"),
      check("maxStockLevel").optional().isNumeric().withMessage("Max stock level must be a number"),
      check("sellingPrice").optional().isNumeric().withMessage("Selling price must be a number"),
      check("isAgriSales").optional().isBoolean().withMessage("isAgriSales must be a boolean value"),
    ],
    checkErrors,
    createProduct
  )
  .get("/products/summary", getInventorySummary)
  .get("/products", getAllProducts)
  .get("/products/:id", getProductById)
  .patch(
    "/products/:id",
    [
      check("name").optional().notEmpty().withMessage("Product name cannot be empty"),
      check("category").optional().notEmpty().withMessage("Product category cannot be empty"),
      check("unit").optional().notEmpty().withMessage("Product unit cannot be empty"),
      check("costPrice").optional().isNumeric().withMessage("Cost price must be a number"),
      check("minStockLevel").optional().isNumeric().withMessage("Min stock level must be a number"),
      check("maxStockLevel").optional().isNumeric().withMessage("Max stock level must be a number"),
      check("sellingPrice").optional().isNumeric().withMessage("Selling price must be a number"),
      check("isAgriSales").optional().isBoolean().withMessage("isAgriSales must be a boolean value"),
    ],
    checkErrors,
    updateProduct
  )
  .delete("/products/:id", deleteProduct)
  .patch(
    "/products/:id/toggle-status",
    [
      check("isActive").isBoolean().withMessage("isActive must be a boolean value"),
    ],
    checkErrors,
    toggleProductStatus
  );

// ==================== BATCH ROUTES ====================

router
  .post(
    "/batches/create",
    [
      check("productId").custom(validateObjectId).withMessage("Valid product ID is required"),
      check("batchNumber").notEmpty().withMessage("Batch number is required"),
      check("quantity").isNumeric().withMessage("Quantity must be a number"),
      check("costPrice").isNumeric().withMessage("Cost price must be a number"),
      check("manufacturingDate").optional().isISO8601().withMessage("Invalid manufacturing date format"),
      check("expiryDate").optional().isISO8601().withMessage("Invalid expiry date format"),
      check("receivedBy").optional().custom(validateObjectId).withMessage("Valid user ID is required"),
    ],
    checkErrors,
    createBatch
  )
  .get("/batches/all", getAllBatches);

// ==================== INWARD ROUTES ====================

router
  .post(
    "/inwards/create",
    [
      check("productId").custom(validateObjectId).withMessage("Valid product ID is required"),
      check("batchId").custom(validateObjectId).withMessage("Valid batch ID is required"),
      check("quantity").isNumeric().withMessage("Quantity must be a number"),
      check("costPrice").isNumeric().withMessage("Cost price must be a number"),
      check("receivedBy").optional().custom(validateObjectId).withMessage("Valid user ID is required"),
    ],
    checkErrors,
    createInward
  )
  .get("/inwards/all", getAllInwards);

// ==================== OUTWARD ROUTES ====================

router
  .post(
    "/outwards/create",
    [
      check("productId").custom(validateObjectId).withMessage("Valid product ID is required"),
      check("quantity").isNumeric().withMessage("Quantity must be a number"),
      check("purpose").notEmpty().withMessage("Purpose is required"),
      check("destination").notEmpty().withMessage("Destination is required"),
      check("batchId").optional().custom(validateObjectId).withMessage("Valid batch ID is required"),
      check("sellingPrice").optional().isNumeric().withMessage("Selling price must be a number"),
      check("issuedBy").optional().custom(validateObjectId).withMessage("Valid user ID is required"),
    ],
    checkErrors,
    createOutward
  )
  .get("/outwards/all", getAllOutwards);

// ==================== STOCK ADJUSTMENT ROUTES ====================

router
  .post(
    "/adjustments/create",
    [
      check("productId").custom(validateObjectId).withMessage("Valid product ID is required"),
      check("adjustmentType").isIn(["addition", "subtraction", "correction"]).withMessage("Invalid adjustment type"),
      check("quantity").isNumeric().withMessage("Quantity must be a number"),
      check("reason").notEmpty().withMessage("Reason is required"),
      check("batchId").optional().custom(validateObjectId).withMessage("Valid batch ID is required"),
      check("adjustedBy").optional().custom(validateObjectId).withMessage("Valid user ID is required"),
    ],
    checkErrors,
    createStockAdjustment
  );

// ==================== DASHBOARD ROUTES ====================

router.get("/dashboard", getInventoryDashboard);

// ==================== AGRI SALES PENDING PAYMENTS ROUTE ====================
// Dedicated endpoint for Ram Agri Sales pending payments (for accountant)
router.get("/agri-sales-pending-payments", getAgriSalesPendingPayments);
router.get("/agri-sales-pending-payments/count", getAgriSalesPendingPaymentsCount);

// ==================== AGRI SALES OUTSTANDING ROUTES ====================
router.get("/agri-sales-outstanding-analysis", getAgriSalesOutstandingAnalysis);
router.get("/agri-sales-customer-outstanding", getAgriSalesCustomerOutstanding);

// ==================== AGRI SALES SALES ANALYSIS ROUTES ====================
router.get("/agri-sales-sales-analysis", getAgriSalesSalesAnalysis);

// ==================== RAM AGRI INPUTS PRODUCT MASTER ROUTES ====================
router
  .post(
    "/ram-agri-inputs",
    [
      check("cropName").notEmpty().withMessage("Crop name is required"),
      check("varieties").optional().isArray().withMessage("Varieties must be an array"),
    ],
    checkErrors,
    createCrop
  )
  .get("/ram-agri-inputs", getAllCrops)
  .get("/ram-agri-inputs/:id", getCropById)
  .patch(
    "/ram-agri-inputs/:id",
    [
      check("cropName").optional().notEmpty().withMessage("Crop name cannot be empty"),
    ],
    checkErrors,
    updateCrop
  )
  .delete("/ram-agri-inputs/:id", deleteCrop)
  .post(
    "/ram-agri-inputs/:id/varieties",
    [
      check("name").notEmpty().withMessage("Variety name is required"),
    ],
    checkErrors,
    addVariety
  )
  .patch(
    "/ram-agri-inputs/:id/varieties/:varietyId",
    [
      check("name").optional().notEmpty().withMessage("Variety name cannot be empty"),
    ],
    checkErrors,
    updateVariety
  )
  .delete("/ram-agri-inputs/:id/varieties/:varietyId", deleteVariety)
  .post(
    "/ram-agri-inputs/:id/varieties/:varietyId/rates",
    [
      check("minRate").optional().isNumeric().withMessage("Min rate must be a number"),
      check("maxRate").optional().isNumeric().withMessage("Max rate must be a number"),
      check("rate").optional().isNumeric().withMessage("Rate must be a number"),
      check("startDate").notEmpty().withMessage("Start date is required"),
      check("endDate").notEmpty().withMessage("End date is required"),
    ],
    checkErrors,
    addRate
  )
  .patch(
    "/ram-agri-inputs/:id/varieties/:varietyId/rates/:rateId",
    [
      check("minRate").optional().isNumeric().withMessage("Min rate must be a number"),
      check("maxRate").optional().isNumeric().withMessage("Max rate must be a number"),
      check("rate").optional().isNumeric().withMessage("Rate must be a number"),
    ],
    checkErrors,
    updateRate
  )
  .delete("/ram-agri-inputs/:id/varieties/:varietyId/rates/:rateId", deleteRate);

// ==================== INVENTORY CHANGE LOG ROUTES ====================
import {
  getChangeLogsByEntity,
  getAllChangeLogs,
  getChangeLogStats,
} from "../controllers/inventoryChangeLog.controller.js";

router.get("/change-logs", getAllChangeLogs);
router.get("/change-logs/stats", getChangeLogStats);
router.get("/change-logs/:entityType/:entityId", getChangeLogsByEntity);

// ==================== RAM AGRI SALES DASHBOARD ====================
router.get("/ram-agri-sales-dashboard", getRamAgriSalesDashboard);
router.get("/ram-agri-sales-rankboard", getRamAgriSalesRankboard);
router
  .get("/ram-agri-sales-targets", getRamAgriSalesTargets)
  .post("/ram-agri-sales-targets", upsertRamAgriSalesTarget);

// ==================== RAM AGRI LEDGERS ====================
router.get("/ram-agri-variety-ledger", getVarietyLedger);
router.get("/ram-agri-customer-ledger", getCustomerLedger);
router.delete(
  "/ram-agri-customer-ledger",
  [
    check("customerMobile")
      .notEmpty()
      .withMessage("Customer mobile is required")
      .isLength({ min: 10, max: 10 })
      .withMessage("Customer mobile must be 10 digits"),
  ],
  checkErrors,
  clearCustomerLedger
);
router.get("/ram-agri-merchant-ledger", getMerchantLedger);

export default router; 