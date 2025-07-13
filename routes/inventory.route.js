import express from "express";
import { check } from "express-validator";
import mongoose from "mongoose";
import checkErrors from "../middlewares/checkErrors.middleware.js";
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
  
  // Dashboard
  getInventoryDashboard,
} from "../controllers/inventory.controller.js";

const router = express.Router();

const validateObjectId = (value) => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new Error("Invalid ID format");
  }
  return true;
};

// ==================== PRODUCT ROUTES ====================

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
    ],
    checkErrors,
    createProduct
  )
  .get("/products/all", getAllProducts)
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

export default router; 