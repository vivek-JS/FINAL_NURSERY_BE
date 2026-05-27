import mongoose, { Schema } from "mongoose";

/**
 * payment_reconciliation — audit trail for each match attempt / result.
 */
const paymentReconciliationSchema = new Schema(
  {
    paymentId: { type: String, required: true, index: true },
    orderMongoId: { type: String, required: true, index: true },
    orderId: { type: String, index: true },
    source: { type: String, enum: ["order", "agriSales"], required: true },
    bankTransactionId: {
      type: Schema.Types.ObjectId,
      ref: "BankStatementEntry",
      index: true,
    },
    matchType: {
      type: String,
      enum: ["EXACT", "FUZZY", "MANUAL", "STATUS_API", "NONE"],
      default: "NONE",
    },
    matchRule: { type: String },
    confidenceScore: { type: Number, min: 0, max: 100 },
    previousStatus: { type: String },
    newStatus: { type: String },
    utr: { type: String, index: true },
    amount: { type: Number },
    accountNumber: { type: String },
    txnDate: { type: Date },
    narration: { type: String },
    runId: { type: String, index: true },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    notes: { type: String },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

paymentReconciliationSchema.index({ paymentId: 1, bankTransactionId: 1 }, { unique: true, sparse: true });

const PaymentReconciliation =
  mongoose.models.PaymentReconciliation ||
  mongoose.model("PaymentReconciliation", paymentReconciliationSchema);

export default PaymentReconciliation;
