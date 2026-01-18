import mongoose, { Schema, model } from "mongoose";

// Payment Schema for Agri Sales Orders
const paymentSchema = new Schema({
  paidAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  paymentStatus: {
    type: String,
    enum: ["COLLECTED", "REJECTED", "PENDING"],
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
    enum: ["Cash", "UPI", "Cheque", "NEFT/RTGS", "1341", "434", "Wallet"],
  },
  transactionId: {
    type: String,
    trim: true,
    // This field stores: UTR/Transaction ID for UPI, Cheque Number for Cheque, Transaction ID for NEFT/RTGS and others
  },
  remark: {
    type: String,
  },
  isWalletPayment: {
    type: Boolean,
    default: false,
  },
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
    orderStatus: {
      type: String,
      enum: ["PENDING", "ACCEPTED", "REJECTED", "COMPLETED", "CANCELLED"],
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
  // Recalculate total amount if quantity or rate changes
  if (this.isModified("quantity") || this.isModified("rate")) {
    this.totalAmount = (this.quantity || 0) * (this.rate || 0);
  }

  // Recalculate payment status and balance if payment changes
  if (this.isModified("payment") || this.isModified("totalAmount")) {
    const totalPaid = this.payment && this.payment.length > 0
      ? this.payment.reduce((sum, p) => {
          if (p.paymentStatus === "COLLECTED") {
            return sum + (p.paidAmount || 0);
          }
          return sum;
        }, 0)
      : 0;

    this.totalPaidAmount = totalPaid;
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
      } else if (p.paymentStatus === "PENDING") {
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

