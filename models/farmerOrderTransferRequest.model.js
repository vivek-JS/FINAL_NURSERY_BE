import mongoose from "mongoose";

const snapshotSchema = new mongoose.Schema(
  {
    orderNumber: { type: Number, default: null },
    farmerId: { type: mongoose.Schema.Types.ObjectId, ref: "Farmer", default: null },
    farmerName: { type: String, trim: true, default: "" },
    farmerMobile: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const approvalSchema = new mongoose.Schema(
  {
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const farmerOrderTransferRequestSchema = new mongoose.Schema(
  {
    fromOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    toOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    requestedAmount: { type: Number, required: true, min: 0.01 },
    note: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"],
      default: "PENDING",
      index: true,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    requestedAt: { type: Date, default: Date.now },
    approval: { type: approvalSchema, default: () => ({}) },
    fromOrderSnapshot: { type: snapshotSchema, default: () => ({}) },
    toOrderSnapshot: { type: snapshotSchema, default: () => ({}) },
    postedAt: { type: Date, default: null },
    ledgerTxnId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    postedMetadata: {
      sourcePaymentId: { type: mongoose.Schema.Types.ObjectId, default: null },
      targetPaymentId: { type: mongoose.Schema.Types.ObjectId, default: null },
      reversalLedgerEntryId: { type: mongoose.Schema.Types.ObjectId, default: null },
      paymentLedgerEntryId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
  },
  { timestamps: true }
);

farmerOrderTransferRequestSchema.index({ status: 1, requestedAt: -1 });
farmerOrderTransferRequestSchema.index({ requestedBy: 1, requestedAt: -1 });
farmerOrderTransferRequestSchema.index({ fromOrderId: 1, toOrderId: 1, requestedAt: -1 });

const FarmerOrderTransferRequest = mongoose.model(
  "FarmerOrderTransferRequest",
  farmerOrderTransferRequestSchema
);

export default FarmerOrderTransferRequest;
