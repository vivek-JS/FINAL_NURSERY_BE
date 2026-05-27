import mongoose, { Schema } from "mongoose";

/**
 * suspense_entries — unmatched bank credits or ambiguous payments.
 */
const suspenseEntrySchema = new Schema(
  {
    bankTransactionId: {
      type: Schema.Types.ObjectId,
      ref: "BankStatementEntry",
      index: true,
    },
    paymentId: { type: String, index: true },
    orderMongoId: { type: String },
    source: { type: String, enum: ["order", "agriSales", "bank_only"] },
    reason: {
      type: String,
      enum: [
        "NO_MATCH",
        "MULTIPLE_MATCH",
        "AMOUNT_MISMATCH",
        "DATE_MISMATCH",
        "ORPHAN_CREDIT",
        "MANUAL_REVIEW",
      ],
      required: true,
    },
    status: {
      type: String,
      enum: ["OPEN", "IN_REVIEW", "RESOLVED", "WRITTEN_OFF"],
      default: "OPEN",
      index: true,
    },
    utr: { type: String, index: true },
    amount: { type: Number, required: true },
    accountNumber: { type: String },
    txnDate: { type: Date },
    narration: { type: String },
    confidenceScore: { type: Number },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User" },
    resolvedAt: { type: Date },
    resolutionNotes: { type: String },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

suspenseEntrySchema.index({ status: 1, createdAt: -1 });

const SuspenseEntry =
  mongoose.models.SuspenseEntry || mongoose.model("SuspenseEntry", suspenseEntrySchema);

export default SuspenseEntry;
