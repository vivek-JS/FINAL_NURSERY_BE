import express from "express";
import { check } from "express-validator";
import mongoose from "mongoose";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import {
  // Purchase Order controllers
  createPurchaseOrder,
  getAllPurchaseOrders,
  getPurchaseOrderById,
  updatePurchaseOrder,
  approvePurchaseOrder,
  
  // GRN controllers
  createGRN,
  getAllGRNs,
  
  // Product Dispatch controllers
  createProductDispatch,
  getAllProductDispatches,
  
  // Sell Order controllers
  createSellOrder,
  getAllSellOrders,
  updateSellOrderPayment,
  confirmSellOrder,
} from "../controllers/purchase.controller.js";

const router = express.Router();

const validateObjectId = (value) => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new Error("Invalid ID format");
  }
  return true;
};

// ==================== PURCHASE ORDER ROUTES ====================

router
  .post(
    "/purchase-orders/create",
    [
      check("supplier.name").notEmpty().withMessage("Supplier name is required"),
      check("supplier.contact").optional().isMobilePhone().withMessage("Invalid contact number"),
      check("supplier.email").optional().isEmail().withMessage("Invalid email format"),
      check("expectedDeliveryDate").optional().isISO8601().withMessage("Invalid delivery date format"),
      check("items").isArray({ min: 1 }).withMessage("At least one item is required"),
      check("items.*.productId").custom(validateObjectId).withMessage("Valid product ID is required"),
      check("items.*.quantity").isNumeric().withMessage("Quantity must be a number"),
      check("items.*.rate").isNumeric().withMessage("Rate must be a number"),
    ],
    checkErrors,
    createPurchaseOrder
  )
  .get("/purchase-orders/all", getAllPurchaseOrders)
  .get("/purchase-orders/:id", getPurchaseOrderById)
  .patch(
    "/purchase-orders/:id",
    [
      check("supplier.name").optional().notEmpty().withMessage("Supplier name cannot be empty"),
      check("supplier.contact").optional().isMobilePhone().withMessage("Invalid contact number"),
      check("supplier.email").optional().isEmail().withMessage("Invalid email format"),
      check("expectedDeliveryDate").optional().isISO8601().withMessage("Invalid delivery date format"),
      check("items").optional().isArray({ min: 1 }).withMessage("At least one item is required"),
      check("items.*.productId").optional().custom(validateObjectId).withMessage("Valid product ID is required"),
      check("items.*.quantity").optional().isNumeric().withMessage("Quantity must be a number"),
      check("items.*.rate").optional().isNumeric().withMessage("Rate must be a number"),
    ],
    checkErrors,
    updatePurchaseOrder
  )
  .patch("/purchase-orders/:id/approve", approvePurchaseOrder);

// ==================== GRN ROUTES ====================

router
  .post(
    "/grn/create",
    [
      check("purchaseOrderId").custom(validateObjectId).withMessage("Valid purchase order ID is required"),
      check("items").isArray({ min: 1 }).withMessage("At least one item is required"),
      check("items.*.productId").custom(validateObjectId).withMessage("Valid product ID is required"),
      check("items.*.receivedQuantity").isNumeric().withMessage("Received quantity must be a number"),
      check("items.*.rate").isNumeric().withMessage("Rate must be a number"),
      check("additionalItems.*.productId").optional().custom(validateObjectId).withMessage("Valid product ID is required"),
      check("additionalItems.*.quantity").optional().isNumeric().withMessage("Quantity must be a number"),
      check("additionalItems.*.rate").optional().isNumeric().withMessage("Rate must be a number"),
    ],
    checkErrors,
    createGRN
  )
  .get("/grn/all", getAllGRNs);

// ==================== PRODUCT DISPATCH ROUTES ====================

router
  .post(
    "/dispatch/create",
    [
      check("driver.name").notEmpty().withMessage("Driver name is required"),
      check("driver.contact").notEmpty().withMessage("Driver contact is required"),
      check("vehicle.number").notEmpty().withMessage("Vehicle number is required"),
      check("items").isArray({ min: 1 }).withMessage("At least one item is required"),
      check("items.*.productId").custom(validateObjectId).withMessage("Valid product ID is required"),
      check("items.*.quantity").isNumeric().withMessage("Quantity must be a number"),
      check("destination.address").notEmpty().withMessage("Destination address is required"),
    ],
    checkErrors,
    createProductDispatch
  )
  .get("/dispatch/all", getAllProductDispatches);

// ==================== SELL ORDER ROUTES ====================

router
  .post(
    "/sell-orders/create",
    [
      check("farmer.name").notEmpty().withMessage("Farmer name is required"),
      check("farmer.mobile").isMobilePhone().withMessage("Valid mobile number is required"),
      check("farmer.district").notEmpty().withMessage("District is required"),
      check("farmer.village").notEmpty().withMessage("Village is required"),
      check("farmer.taluka").notEmpty().withMessage("Taluka is required"),
      check("items").isArray({ min: 1 }).withMessage("At least one item is required"),
      check("items.*.productId").custom(validateObjectId).withMessage("Valid product ID is required"),
      check("items.*.quantity").isNumeric().withMessage("Quantity must be a number"),
      check("items.*.rate").isNumeric().withMessage("Rate must be a number"),
      check("paymentMode").isIn(["cash", "cheque", "bank_transfer", "upi", "card", "other"]).withMessage("Invalid payment mode"),
    ],
    checkErrors,
    createSellOrder
  )
  .get("/sell-orders/all", getAllSellOrders)
  .patch(
    "/sell-orders/:id/payment",
    [
      check("receivedAmount").isNumeric().withMessage("Received amount must be a number"),
      check("paymentMode").isIn(["cash", "cheque", "bank_transfer", "upi", "card", "other"]).withMessage("Invalid payment mode"),
    ],
    checkErrors,
    updateSellOrderPayment
  )
  .patch("/sell-orders/:id/confirm", confirmSellOrder);

export default router;
