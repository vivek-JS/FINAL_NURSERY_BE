import mongoose, { Schema, model } from "mongoose";

// Order Edit History Schema - tracks field-level changes (same as regular orders)
const orderEditHistorySchema = new Schema(
  {
    field: {
      type: String,
      required: true,
      // Field that was changed (e.g., 'rate', 'quantity', 'deliveryDate')
    },
    previousValue: {
      type: Schema.Types.Mixed,
      // Store the old value (can be any type)
    },
    newValue: {
      type: Schema.Types.Mixed,
      required: true,
      // Store the new value (can be any type)
    },
    changedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    notes: {
      type: String,
    },
  },
  { timestamps: true }
);

// Activity/History Log Schema for tracking all changes
const activityLogSchema = new Schema({
  action: {
    type: String,
    required: true,
    enum: [
      "ORDER_CREATED",
      "ORDER_UPDATED",
      "ORDER_ACCEPTED",
      "ORDER_REJECTED",
      "ORDER_COMPLETED",
      "ORDER_CANCELLED",
      "ORDER_DELIVERED",
      "PAYMENT_ADDED",
      "PAYMENT_UPDATED",
      "PAYMENT_STATUS_CHANGED",
      "CUSTOMER_UPDATED",
      "PRODUCT_UPDATED",
      "QUANTITY_UPDATED",
      "RATE_UPDATED",
      "NOTES_UPDATED",
      "DELIVERY_DATE_UPDATED",
      "STOCK_DEDUCTED",
      "STOCK_RETURNED",
      "ORDER_DISPATCHED",
      "DISPATCH_UPDATED",
      "ORDER_ASSIGNED",
      "ASSIGNMENT_CANCELLED",
      "SALES_RETURN_PROCESSED",
      "PAYMENT_ADJUSTED",
    ],
  },
  description: {
    type: String,
    required: true,
  },
  performedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  performedByName: {
    type: String,
  },
  previousValue: {
    type: Schema.Types.Mixed, // Can store any type of previous value
  },
  newValue: {
    type: Schema.Types.Mixed, // Can store any type of new value
  },
  metadata: {
    type: Schema.Types.Mixed, // Additional context data
  },
}, {
  timestamps: true,
});

// Payment Schema for Agri Sales Orders
const paymentSchema = new Schema({
  paidAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  paymentStatus: {
    type: String,
    enum: ["COLLECTED", "REJECTED", "PENDING", "BANK_VERIFIED"],
    default: "PENDING",
  },
  paymentDate: {
    type: Date,
    required: true,
    default: Date.now,
  },
  bankName: {
    type: String,
  },
  receiptPhoto: [
    {
      type: String, // Cloudinary URLs
    },
  ],
  modeOfPayment: {
    type: String,
    enum: ["Cash", "UPI", "Cheque", "NEFT/RTGS", "1341", "434", "Wallet", "UPI_QR"],
  },
  transactionId: {
    type: String,
    trim: true,
    // This field stores: UTR/Transaction ID for UPI, Cheque Number for Cheque, Transaction ID for NEFT/RTGS and others
  },
  chequeNumber: {
    type: String,
    trim: true,
  },
  remark: {
    type: String,
  },
  isWalletPayment: {
    type: Boolean,
    default: false,
  },
  mainPaymentId: {
    type: Schema.Types.ObjectId,
    ref: "BulkPayment",
    default: null,
  },
  qrReferenceId: { type: String, trim: true },
  qrExpiresAt: { type: Date },
  qrImage: { type: String },
  qrPayload: { type: String },
  customerName: { type: String, trim: true },
  utrNumber: { type: String, trim: true },
  merchantTranId: { type: String, trim: true },
  providerTxnId: { type: String, trim: true },
  bankVerificationStatus: {
    type: String,
    enum: ["PENDING", "BANK_VERIFIED", "VERIFY_FAILED", "NOT_REQUIRED"],
    default: "PENDING",
  },
  bankVerificationSource: {
    type: String,
    enum: ["STATEMENT_API", "TXN_STATUS_API", "MANUAL", null],
    default: null,
  },
  bankVerificationMatchedBy: {
    type: String,
    enum: ["UTR", "CHEQUE", "TXN_ID", "AMOUNT_DATE", null],
    default: null,
  },
  bankReferenceNumber: { type: String, trim: true },
  bankNarration: { type: String, trim: true },
  bankAmount: { type: Number },
  bankEntryDate: { type: Date },
  bankRawResponse: { type: Schema.Types.Mixed },
  bankReconciliationConflict: { type: Boolean, default: false },
}, {
  timestamps: true,
});

/** One product line on an Agri Sales order (multi-product orders). Legacy orders omit this and use root-level product fields only. */
const agriLineItemSchema = new Schema(
  {
    sortOrder: { type: Number, default: 0 },
    isRamAgriProduct: { type: Boolean, default: false },
    productId: {
      type: Schema.Types.ObjectId,
      ref: "InventoryProduct",
      default: null,
    },
    ramAgriCropId: {
      type: Schema.Types.ObjectId,
      ref: "RamAgriInputsProduct",
      default: null,
    },
    ramAgriVarietyId: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    ramAgriCropName: { type: String, trim: true },
    ramAgriVarietyName: { type: String, trim: true },
    primaryUnit: {
      type: Schema.Types.ObjectId,
      ref: "MeasurementUnit",
      default: null,
    },
    secondaryUnit: {
      type: Schema.Types.ObjectId,
      ref: "MeasurementUnit",
      default: null,
    },
    conversionFactor: { type: Number, default: 1 },
    productName: { type: String, required: true, trim: true },
    quantity: {
      type: Number,
      required: true,
      validate: {
        validator(v) {
          return typeof v === "number" && !Number.isNaN(v) && v > 0;
        },
        message: "Line quantity must be greater than 0",
      },
    },
    unit: {
      type: String,
      enum: ["kg", "g", "l", "ml", "pieces", "packets", "bottles", "bags"],
    },
    rate: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number, min: 0 },
    /** Set on order completion when returns are split across lines. */
    returnQuantity: { type: Number, default: 0, min: 0 },
    deliveredQuantity: { type: Number, min: 0 },
  },
  { _id: true }
);

function hasLineItems(doc) {
  return Array.isArray(doc.lineItems) && doc.lineItems.length > 0;
}

/**
 * Sync root-level product fields from `lineItems` for validation, payments, and legacy readers.
 * @param {{ useDeliveredQty?: boolean }} options — when true (completed orders), bill from delivered/return lines
 */
export function rollupAgriLineItemsToRoot(doc, options = {}) {
  const lines = doc.lineItems;
  if (!lines || !lines.length) return;

  const useDelivered = Boolean(options.useDeliveredQty);
  let billableQty = 0;
  let orderedQty = 0;
  let totalAmt = 0;
  lines.forEach((line, idx) => {
    line.sortOrder = line.sortOrder ?? idx;
    const ordered = Number(line.quantity) || 0;
    orderedQty += ordered;
    const returned = Number(line.returnQuantity) || 0;
    const delivered =
      line.deliveredQuantity != null && line.deliveredQuantity !== undefined
        ? Number(line.deliveredQuantity)
        : Math.max(0, ordered - returned);
    const qForBill = useDelivered ? delivered : ordered;
    const r = Number(line.rate) || 0;
    let lt = useDelivered ? qForBill * r : line.lineTotal != null ? Number(line.lineTotal) : ordered * r;
    if (Number.isNaN(lt)) lt = qForBill * r;
    line.lineTotal = roundMoney(lt);
    if (useDelivered) {
      line.deliveredQuantity = delivered;
    }
    billableQty += qForBill;
    totalAmt += line.lineTotal;
  });

  doc.quantity = orderedQty;
  if (useDelivered) {
    doc.deliveredQuantity = billableQty;
  }
  doc.totalAmount = roundMoney(totalAmt);
  doc.rate = billableQty > 0 ? roundMoney(totalAmt / billableQty) : 0;
  doc.productName =
    lines.length === 1
      ? String(lines[0].productName || "").trim() || "Item"
      : `Multiple items (${lines.length})`;

  const anyRam = lines.some((l) => l.isRamAgriProduct);
  const allRam = lines.every((l) => l.isRamAgriProduct);
  doc.isRamAgriProduct = anyRam;

  const firstRam = lines.find((l) => l.isRamAgriProduct);
  const firstInv = lines.find((l) => !l.isRamAgriProduct);

  if (firstRam) {
    doc.ramAgriCropId = firstRam.ramAgriCropId;
    doc.ramAgriVarietyId = firstRam.ramAgriVarietyId;
    doc.ramAgriCropName = firstRam.ramAgriCropName;
    doc.ramAgriVarietyName = firstRam.ramAgriVarietyName;
    doc.primaryUnit = firstRam.primaryUnit;
    doc.secondaryUnit = firstRam.secondaryUnit ?? null;
    doc.conversionFactor = firstRam.conversionFactor ?? 1;
  } else {
    doc.ramAgriCropId = null;
    doc.ramAgriVarietyId = null;
    doc.ramAgriCropName = "";
    doc.ramAgriVarietyName = "";
  }

  if (firstInv) {
    doc.productId = firstInv.productId;
    doc.unit = firstInv.unit || "pieces";
  } else if (allRam) {
    doc.productId = null;
    doc.unit = undefined;
  }

  if (!anyRam && firstInv) {
    doc.ramAgriCropId = null;
    doc.ramAgriVarietyId = null;
  }
}

/** Proportional split of total return units across order lines (integer parts). */
export function distributeReturnQtyAcrossLines(lines, returnQty) {
  const n = lines.length;
  if (!n || returnQty <= 0) return new Array(n).fill(0);
  const qtys = lines.map((l) => Number(l.quantity) || 0);
  const total = qtys.reduce((a, b) => a + b, 0);
  if (total <= 0) return new Array(n).fill(0);
  const out = qtys.map((q) => Math.floor((returnQty * q) / total));
  let diff = returnQty - out.reduce((a, b) => a + b, 0);
  for (let i = n - 1; i >= 0 && diff > 0; i--) {
    const canAdd = Math.min(diff, qtys[i] - out[i]);
    out[i] += canAdd;
    diff -= canAdd;
  }
  return out;
}

export function ramAgriLineMatchesVariety(line, cropId, varietyId) {
  if (!line?.isRamAgriProduct && !line?.ramAgriCropId) return false;
  const crop = String(line.ramAgriCropId || "");
  const variety = String(line.ramAgriVarietyId || "");
  return crop === String(cropId) && variety === String(varietyId);
}

/** Per-line return qty map (uses stored line.returnQuantity when present). */
export function getPerLineReturnQuantities(orderLike, totalReturnQty = null) {
  const lines = getAgriOrderLines(orderLike);
  const total =
    totalReturnQty != null
      ? Number(totalReturnQty) || 0
      : Number(orderLike?.returnQuantity) || 0;
  const hasStored = lines.some((l) => Number(l.returnQuantity) > 0);
  if (hasStored) {
    return lines.map((l) => Number(l.returnQuantity) || 0);
  }
  return distributeReturnQtyAcrossLines(lines, total);
}

/** Delivered qty and billable amount from line delivered/return fields. */
export function computeAgriDeliveredTotalFromLines(orderLike) {
  const lines = getAgriOrderLines(orderLike);
  let totalQty = 0;
  let totalAmt = 0;
  lines.forEach((line) => {
    const ordered = Number(line.quantity) || 0;
    const returned = Number(line.returnQuantity) || 0;
    const delivered =
      line.deliveredQuantity != null && line.deliveredQuantity !== undefined
        ? Number(line.deliveredQuantity)
        : Math.max(0, ordered - returned);
    const rate = Number(line.rate) || 0;
    totalQty += delivered;
    totalAmt += delivered * rate;
  });
  return { totalQty, totalAmt: roundMoney(totalAmt) };
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Rupee credit for returned qty (respects per-line rates). */
export function computeAgriReturnCreditAmount(orderLike, returnQty = null) {
  const lines = getAgriOrderLines(orderLike);
  const rq =
    returnQty != null ? Number(returnQty) || 0 : Number(orderLike?.returnQuantity) || 0;
  const perLine = getPerLineReturnQuantities(orderLike, rq);
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    total += (perLine[i] || 0) * (Number(lines[i].rate) || 0);
  }
  return total;
}

/** Normalize one logical line for stock / ledger (legacy docs have a single implicit line). */
export function getAgriOrderLines(orderLike) {
  const o = orderLike?.toObject ? orderLike.toObject() : orderLike || {};
  if (Array.isArray(o.lineItems) && o.lineItems.length > 0) {
    return o.lineItems.map((line) => ({ ...line }));
  }
  return [
    {
      isRamAgriProduct: Boolean(o.isRamAgriProduct),
      productId: o.productId,
      ramAgriCropId: o.ramAgriCropId,
      ramAgriVarietyId: o.ramAgriVarietyId,
      ramAgriCropName: o.ramAgriCropName,
      ramAgriVarietyName: o.ramAgriVarietyName,
      primaryUnit: o.primaryUnit,
      secondaryUnit: o.secondaryUnit,
      conversionFactor: o.conversionFactor,
      productName: o.productName,
      quantity: o.quantity,
      unit: o.unit,
      rate: o.rate,
      lineTotal: (o.quantity || 0) * (o.rate || 0),
    },
  ];
}

// Agri Sales Order Schema
const agriSalesOrderSchema = new Schema(
  {
    orderNumber: {
      type: String,
      unique: true,
      required: true, // Required after generation in pre-validate hook
      trim: true,
    },
    // Customer/Employee Information
    customerName: {
      type: String,
      required: true,
      trim: true,
    },
    customerMobile: {
      type: String,
      required: true,
      trim: true,
    },
    customerVillage: {
      type: String,
      trim: true,
    },
    customerTaluka: {
      type: String,
      trim: true,
    },
    customerDistrict: {
      type: String,
      trim: true,
    },
    customerState: {
      type: String,
      default: "Maharashtra",
    },
    /** Multiple products per order; when set, root product fields are rolled up from lines in pre-validate. */
    lineItems: {
      type: [agriLineItemSchema],
      default: undefined,
    },
    // Product Information - Support both regular products and Ram Agri products
    isRamAgriProduct: {
      type: Boolean,
      default: false,
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: "InventoryProduct",
      required: function() {
        if (hasLineItems(this)) return false;
        return this.isRamAgriProduct !== true;
      },
    },
    // Ram Agri Product fields
    ramAgriCropId: {
      type: Schema.Types.ObjectId,
      ref: "RamAgriInputsProduct",
      required: function() {
        if (hasLineItems(this)) return false;
        return this.isRamAgriProduct === true;
      },
    },
    ramAgriVarietyId: {
      type: Schema.Types.ObjectId,
      required: function() {
        if (hasLineItems(this)) return false;
        return this.isRamAgriProduct === true;
      },
    },
    ramAgriCropName: {
      type: String,
      trim: true,
    },
    ramAgriVarietyName: {
      type: String,
      trim: true,
    },
    // Unit of Measurement (for Ram Agri products, this comes from variety)
    primaryUnit: {
      type: Schema.Types.ObjectId,
      ref: "MeasurementUnit",
    },
    secondaryUnit: {
      type: Schema.Types.ObjectId,
      ref: "MeasurementUnit",
    },
    conversionFactor: {
      type: Number,
      default: 1,
    },
    productName: {
      type: String,
      required: function () {
        return !hasLineItems(this);
      },
    },
    quantity: {
      type: Number,
      required: function () {
        return !hasLineItems(this);
      },
      validate: {
        validator(v) {
          if (v === undefined || v === null) return true;
          return typeof v === "number" && !Number.isNaN(v) && v > 0;
        },
        message: "Quantity must be greater than 0",
      },
    },
    unit: {
      type: String,
      required: function() {
        if (hasLineItems(this)) return false;
        return !this.isRamAgriProduct;
      },
      enum: ["kg", "g", "l", "ml", "pieces", "packets", "bottles", "bags"],
    },
    rate: {
      type: Number,
      required: function () {
        return !hasLineItems(this);
      },
      min: 0,
    },
    totalAmount: {
      type: Number,
      required: function () {
        return !hasLineItems(this);
      },
      min: 0,
    },
    // Order Status
    // PENDING -> ACCEPTED -> ASSIGNED (optional) -> DISPATCHED -> COMPLETED
    orderStatus: {
      type: String,
      enum: ["PENDING", "ACCEPTED", "ASSIGNED", "DISPATCHED", "REJECTED", "COMPLETED", "CANCELLED"],
      default: "PENDING",
    },
    // Payment Information
    payment: [paymentSchema],
    paymentStatus: {
      type: String,
      enum: ["PENDING", "PARTIAL", "COMPLETED"],
      default: "PENDING",
    },
    totalPaidAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    balanceAmount: {
      type: Number,
      default: 0,
    },
    // Order Details
    orderDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    deliveryDate: {
      type: Date,
    },
    linkedNurseryOrderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    linkedNurseryOrderCode: {
      type: String,
      trim: true,
      default: "",
    },
    agriLoadStatus: {
      type: String,
      enum: ["PENDING_LOAD", "LOADED"],
      default: "PENDING_LOAD",
    },
    loadedAt: {
      type: Date,
      default: null,
    },
    loadedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Employee who created the order
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    /** Attributed Ram Agri sales rep (may differ from createdBy when office/manager books for field). */
    salesPerson: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    // Employee who accepted the order (for stock deduction)
    acceptedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    acceptedAt: {
      type: Date,
    },
    // Stock deduction tracking
    stockDeducted: {
      type: Boolean,
      default: false,
    },
    stockDeductedAt: {
      type: Date,
    },
    // Notes and remarks
    notes: {
      type: String,
    },
    remarks: [String],
    // Screenshots
    screenshots: [String], // Cloudinary URLs
    // Dispatch Information
    dispatchStatus: {
      type: String,
      enum: ["NOT_DISPATCHED", "DISPATCHED", "IN_TRANSIT", "DELIVERED"],
      default: "NOT_DISPATCHED",
    },
    vehicleId: {
      type: Schema.Types.ObjectId,
      ref: "Vehicle",
    },
    vehicleNumber: {
      type: String,
      trim: true,
    },
    driverName: {
      type: String,
      trim: true,
    },
    driverMobile: {
      type: String,
      trim: true,
    },
    dispatchedAt: {
      type: Date,
    },
    dispatchedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    // Dispatch Mode: VEHICLE or COURIER
    dispatchMode: {
      type: String,
      enum: ["VEHICLE", "COURIER", "WITH_ORDER", "OFFICE"],
      default: "VEHICLE",
    },
    // Link trail to the regular nursery dispatch used in WITH_ORDER mode
    linkedNurseryDispatchId: {
      type: Schema.Types.ObjectId,
      ref: "Dispatch",
      default: null,
    },
    linkedNurseryTransportId: {
      type: String,
      trim: true,
      default: "",
    },
    linkedNurseryDispatchDate: {
      type: Date,
      default: null,
    },
    // Courier fields (when dispatchMode is COURIER)
    courierName: {
      type: String,
      trim: true,
    },
    courierTrackingId: {
      type: String,
      trim: true,
    },
    courierContact: {
      type: String,
      trim: true,
    },
    dispatchNotes: {
      type: String,
      trim: true,
    },
    // Assignment Information (when admin assigns to sales person for dispatch)
    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    assignedAt: {
      type: Date,
    },
    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    assignmentNotes: {
      type: String,
      trim: true,
    },
    // Order Completion Information (after delivery)
    completedAt: {
      type: Date,
    },
    completedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    // Return Information (if customer returns some quantity)
    returnQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    returnReason: {
      type: String,
      trim: true,
    },
    returnNotes: {
      type: String,
      trim: true,
    },
    // Actual delivered quantity (quantity - returnQuantity)
    deliveredQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Stock returned (added back to inventory)
    stockReturned: {
      type: Boolean,
      default: false,
    },
    stockReturnedAt: {
      type: Date,
    },
    // Sales Return Information (for orders dispatched by sales person - NO stock impact)
    salesReturnQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    salesReturnReason: {
      type: String,
      trim: true,
    },
    salesReturnNotes: {
      type: String,
      trim: true,
    },
    salesReturnedAt: {
      type: Date,
    },
    salesReturnedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    // Payment adjustments for sales returns (can be negative for refunds/credits)
    paymentAdjustments: [
      {
        amount: {
          type: Number,
          required: true, // Can be negative for refunds/credits
        },
        adjustmentType: {
          type: String,
          enum: ["REFUND", "CREDIT", "ADJUSTMENT", "DEDUCTION"],
          required: true,
        },
        reason: {
          type: String,
          trim: true,
        },
        notes: {
          type: String,
          trim: true,
        },
        adjustedAt: {
          type: Date,
          default: Date.now,
        },
        adjustedBy: {
          type: Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        adjustedByName: {
          type: String,
        },
        paymentId: {
          type: Schema.Types.ObjectId, // Reference to original payment if applicable
        },
      },
    ],
    // Order Edit History - tracks field-level changes (same as regular orders)
    orderEditHistory: [orderEditHistorySchema],
    // Activity/History Log - tracks all changes to the order
    activityLog: [activityLogSchema],
  },
  {
    timestamps: true,
  }
);

// Indexes for better query performance
// Note: orderNumber already has unique: true in schema definition, which automatically creates an index
agriSalesOrderSchema.index({ customerMobile: 1 }); // For customer lookup
agriSalesOrderSchema.index({ productId: 1 }); // For product-based queries
agriSalesOrderSchema.index({ orderStatus: 1 }); // For status filtering
agriSalesOrderSchema.index({ createdBy: 1 }); // For user-wise filtering (employee who created)
agriSalesOrderSchema.index({ salesPerson: 1 }); // Attributed Ram Agri sales rep
agriSalesOrderSchema.index({ acceptedBy: 1 }); // For user who accepted
agriSalesOrderSchema.index({ orderDate: -1 }); // For date-based sorting
agriSalesOrderSchema.index({ paymentStatus: 1 }); // For payment filtering
agriSalesOrderSchema.index({ stockDeducted: 1 }); // For stock deduction tracking
agriSalesOrderSchema.index({ createdAt: -1 }); // For creation time sorting
agriSalesOrderSchema.index({ dispatchStatus: 1 }); // For dispatch filtering
agriSalesOrderSchema.index({ linkedNurseryOrderId: 1 });
agriSalesOrderSchema.index({ linkedNurseryOrderId: 1, agriLoadStatus: 1 });

// Compound indexes for common queries
agriSalesOrderSchema.index({ createdBy: 1, orderStatus: 1 }); // User's orders by status
agriSalesOrderSchema.index({ orderDate: 1, orderStatus: 1 }); // Date and status filtering
agriSalesOrderSchema.index({ customerMobile: 1, orderDate: -1 }); // Customer orders by date
agriSalesOrderSchema.index({ "lineItems.productId": 1 });
agriSalesOrderSchema.index({ "lineItems.ramAgriVarietyId": 1 });

// Generate order number before validation (runs before schema validation)
agriSalesOrderSchema.pre("validate", async function (next) {
  try {
    if (hasLineItems(this)) {
      rollupAgriLineItemsToRoot(this);
    }
  } catch (err) {
    return next(err);
  }

  // Only generate order number for new documents that don't have one
  if (!this.isNew || (this.orderNumber && this.orderNumber.trim())) {
    return next();
  }

  try {
    const today = new Date();
    const year = today.getFullYear().toString().slice(-2); // Last 2 digits of year
    const month = (today.getMonth() + 1).toString().padStart(2, "0");
    const day = today.getDate().toString().padStart(2, "0");
    const datePrefix = `${year}${month}${day}`;

    // Get the model for querying - try multiple methods
    let AgriSalesOrderModel;
    if (mongoose.models && mongoose.models.AgriSalesOrder) {
      AgriSalesOrderModel = mongoose.models.AgriSalesOrder;
    } else if (this.constructor && this.constructor.modelName === "AgriSalesOrder") {
      AgriSalesOrderModel = this.constructor;
    } else {
      // Try to get model directly (might throw if not registered)
      try {
        AgriSalesOrderModel = mongoose.model("AgriSalesOrder");
      } catch (modelError) {
        // Model not registered yet - use timestamp fallback
        const timestamp = Date.now().toString().slice(-6);
        this.orderNumber = `AGR-${datePrefix}-${timestamp}`;
        return next();
      }
    }
    
    // Find the last order for today's date
    let lastOrder = null;
    try {
      lastOrder = await AgriSalesOrderModel
        .findOne({ orderNumber: new RegExp(`^AGR-${datePrefix}-`) })
        .sort({ orderNumber: -1 })
        .lean()
        .exec();
    } catch (queryError) {
      // If query fails, use timestamp fallback
      console.warn("Could not query for last order number, using timestamp fallback:", queryError.message);
      const timestamp = Date.now().toString().slice(-6);
      this.orderNumber = `AGR-${datePrefix}-${timestamp}`;
      return next();
    }

    let orderNum = 1;
    if (lastOrder && lastOrder.orderNumber) {
      const parts = lastOrder.orderNumber.split("-");
      if (parts.length === 3 && parts[2]) {
        const lastNum = parseInt(parts[2], 10);
        if (!isNaN(lastNum) && lastNum > 0) {
          orderNum = lastNum + 1;
        }
      }
    }

    this.orderNumber = `AGR-${datePrefix}-${orderNum.toString().padStart(3, "0")}`;
    next();
  } catch (error) {
    console.error("Error generating order number:", error);
    // Fallback: use timestamp-based order number if generation fails
    const today = new Date();
    const year = today.getFullYear().toString().slice(-2);
    const month = (today.getMonth() + 1).toString().padStart(2, "0");
    const day = today.getDate().toString().padStart(2, "0");
    const timestamp = Date.now().toString().slice(-6);
    this.orderNumber = `AGR-${year}${month}${day}-${timestamp}`;
    next(); // Don't fail - use fallback order number
  }
});

// Calculate total amount and balance before save
agriSalesOrderSchema.pre("save", function (next) {
  if (hasLineItems(this)) {
    rollupAgriLineItemsToRoot(this, {
      useDeliveredQty: this.orderStatus === "COMPLETED",
    });
  }

  // Recalculate total amount if quantity, rate, or deliveredQuantity changes
  // For completed orders, use deliveredQuantity; otherwise use quantity
  if (
    !hasLineItems(this) &&
    (this.isModified("quantity") ||
      this.isModified("rate") ||
      this.isModified("deliveredQuantity") ||
      this.isModified("orderStatus"))
  ) {
    const quantityForAmount =
      this.orderStatus === "COMPLETED" && this.deliveredQuantity > 0
        ? this.deliveredQuantity
        : this.quantity || 0;

    this.totalAmount = quantityForAmount * (this.rate || 0);
  }

  // Recalculate payment status and balance if payment changes
  if (this.isModified("payment") || this.isModified("totalAmount") || this.isModified("deliveredQuantity") || this.isModified("orderStatus")) {
    const totalPaid = this.payment && this.payment.length > 0
      ? this.payment.reduce((sum, p) => {
          if (p.paymentStatus === "COLLECTED") {
            return sum + (p.paidAmount || 0);
          }
          return sum;
        }, 0)
      : 0;

    this.totalPaidAmount = totalPaid;

    if (!hasLineItems(this) && this.orderStatus === "COMPLETED" && this.deliveredQuantity > 0) {
      this.totalAmount = this.deliveredQuantity * (this.rate || 0);
    }

    this.balanceAmount = (this.totalAmount || 0) - totalPaid;

    // Update payment status
    if (this.balanceAmount <= 0) {
      this.paymentStatus = "COMPLETED";
    } else if (totalPaid > 0) {
      this.paymentStatus = "PARTIAL";
    } else {
      this.paymentStatus = "PENDING";
    }
  }

  next();
});

// Virtual for payment summary
agriSalesOrderSchema.virtual("paymentSummary").get(function () {
  if (!this.payment || this.payment.length === 0) {
    return {
      totalPaid: 0,
      totalPending: 0,
      totalRejected: 0,
      count: 0,
    };
  }

  return this.payment.reduce(
    (summary, p) => {
      summary.count++;
      if (p.paymentStatus === "COLLECTED") {
        summary.totalPaid += p.paidAmount || 0;
      } else if (p.paymentStatus === "PENDING" || p.paymentStatus === "BANK_VERIFIED") {
        summary.totalPending += p.paidAmount || 0;
      } else if (p.paymentStatus === "REJECTED") {
        summary.totalRejected += p.paidAmount || 0;
      }
      return summary;
    },
    { totalPaid: 0, totalPending: 0, totalRejected: 0, count: 0 }
  );
});

// Ensure virtuals are included in JSON output
agriSalesOrderSchema.set("toJSON", { virtuals: true });
agriSalesOrderSchema.set("toObject", { virtuals: true });

const AgriSalesOrder = model("AgriSalesOrder", agriSalesOrderSchema);

export default AgriSalesOrder;

