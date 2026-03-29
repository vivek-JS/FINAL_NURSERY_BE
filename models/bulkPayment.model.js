import mongoose, { Schema, model } from "mongoose";

const allocationSchema = new Schema(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    orderType: {
      type: String,
      required: true,
      enum: ["ORDER", "AgriSalesOrder"],
    },
  },
  { _id: false }
);

const bulkPaymentSchema = new Schema(
  {
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    paymentDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    modeOfPayment: {
      type: String,
      required: true,
      enum: ["Cash", "UPI", "Cheque", "NEFT/RTGS", "1341", "434", "Wallet"],
    },
    bankName: { type: String },
    receiptPhoto: [
      {
        type: String,
      },
    ],
    remark: { type: String },
    transactionId: { type: String, trim: true },
    /** UPI / NEFT bank reference (separate from app transaction id when both exist). */
    utrNumber: { type: String, trim: true },
    paymentStatus: {
      type: String,
      enum: ["PENDING", "ACCEPTED"],
      default: "PENDING",
    },
    allocations: {
      type: [allocationSchema],
      required: true,
      validate: {
        validator(arr) {
          return Array.isArray(arr) && arr.length > 0;
        },
        message: "At least one allocation is required",
      },
    },
    source: {
      type: String,
      enum: ["PLANT", "AGRI", "MIXED"],
      default: "MIXED",
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    acceptedAt: { type: Date },
    acceptedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

bulkPaymentSchema.index({ paymentDate: -1 });
bulkPaymentSchema.index({ paymentStatus: 1 });
bulkPaymentSchema.index({ createdBy: 1 });

const BulkPayment = model("BulkPayment", bulkPaymentSchema);
export default BulkPayment;
