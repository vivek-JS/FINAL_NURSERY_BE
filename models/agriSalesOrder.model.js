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
    // Product Information - Support both regular products and Ram Agri products
    isRamAgriProduct: {
      type: Boolean,
      default: false,
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: "InventoryProduct",
      required: function() {
        // Only required if isRamAgriProduct is explicitly false or undefined
        return this.isRamAgriProduct !== true;
      },
    },
    // Ram Agri Product fields
    ramAgriCropId: {
      type: Schema.Types.ObjectId,
      ref: "RamAgriInputsProduct",
      required: function() {
        // Only required if isRamAgriProduct is explicitly true
        return this.isRamAgriProduct === true;
      },
    },
    ramAgriVarietyId: {
      type: Schema.Types.ObjectId,
      required: function() {
        // Only required if isRamAgriProduct is explicitly true
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
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    unit: {
      type: String,
      required: function() {
        return !this.isRamAgriProduct;
      },
      enum: ["kg", "g", "l", "ml", "pieces", "packets", "bottles", "bags"],
    },
    rate: {
      type: Number,
      required: true,
      min: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
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
      enum: ["VEHICLE", "COURIER"],
      default: "VEHICLE",
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

// Generate order number before validation (runs before schema validation)
agriSalesOrderSchema.pre("validate", async function (next) {
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
  // Recalculate total amount if quantity, rate, or deliveredQuantity changes
  // For completed orders, use deliveredQuantity; otherwise use quantity
  if (this.isModified("quantity") || this.isModified("rate") || this.isModified("deliveredQuantity") || this.isModified("orderStatus")) {
    // If order is completed and has deliveredQuantity, use that for payment calculation
    // Otherwise use original quantity
    const quantityForAmount = (this.orderStatus === "COMPLETED" && this.deliveredQuantity > 0) 
      ? this.deliveredQuantity 
      : (this.quantity || 0);
    
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
    
    // For completed orders, recalculate totalAmount based on deliveredQuantity
    if (this.orderStatus === "COMPLETED" && this.deliveredQuantity > 0) {
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

