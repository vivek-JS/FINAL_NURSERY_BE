import mongoose from "mongoose";

const batchReturnSchema = new mongoose.Schema(
  {
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: "RamAgriBatch", required: true },
    batchNumber: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const lineReturnSchema = new mongoose.Schema(
  {
    lineItemId: { type: mongoose.Schema.Types.ObjectId },
    ramAgriVarietyId: { type: mongoose.Schema.Types.ObjectId },
    productName: { type: String, trim: true },
    returnQuantity: { type: Number, required: true, min: 0 },
    batchReturns: { type: [batchReturnSchema], default: [] },
  },
  { _id: true }
);

const agriSalesReturnRequestSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AgriSalesOrder",
      required: true,
      index: true,
    },
    orderNumber: { type: String, trim: true, index: true },
    /** MERCHANT_BATCH = one office return spanning N orders; DEALER / ORDER_WISE = single order */
    source: {
      type: String,
      enum: ["DEALER", "MERCHANT_BATCH", "ORDER_WISE"],
      default: "DEALER",
      index: true,
    },
    merchantBatchGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
    },
    /** When source=MERCHANT_BATCH: all orders touched by this one return action */
    affectedOrders: [
      {
        orderId: { type: mongoose.Schema.Types.ObjectId, ref: "AgriSalesOrder" },
        orderNumber: { type: String, trim: true },
        customerName: { type: String, trim: true },
        returnQuantity: { type: Number, default: 0 },
        creditAmount: { type: Number, default: 0 },
      },
    ],
    /** Batches returned in this action (list / expand) */
    appliedBatches: [
      {
        batchId: { type: mongoose.Schema.Types.ObjectId },
        batchNumber: { type: String, trim: true },
        quantity: { type: Number, default: 0 },
        productName: { type: String, trim: true },
      },
    ],
    dealer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"],
      default: "PENDING",
      index: true,
    },
    lineReturns: { type: [lineReturnSchema], default: [] },
    returnReason: { type: String, trim: true },
    returnNotes: { type: String, trim: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    requestedAt: { type: Date, default: Date.now },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    reviewNotes: { type: String, trim: true },
    ledgerRefId: { type: mongoose.Schema.Types.ObjectId },
    stockReturned: { type: Boolean, default: false },
    creditAmount: { type: Number, default: 0, min: 0 },
    /** Generated credit-note invoice # (SRIYY#####) */
    invoiceNumber: { type: String, trim: true, index: true, sparse: true },
    invoiceGeneratedAt: { type: Date },
  },
  { timestamps: true }
);

agriSalesReturnRequestSchema.index({ orderId: 1, status: 1 });

const AgriSalesReturnRequest = mongoose.model(
  "AgriSalesReturnRequest",
  agriSalesReturnRequestSchema
);

export default AgriSalesReturnRequest;
