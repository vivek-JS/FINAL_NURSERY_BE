import mongoose, { Schema } from "mongoose";

/**
 * Normalised ICICI bank statement lines for ERP reconciliation.
 * Dedupe by entryHash when inserting.
 */
const bankStatementEntrySchema = new Schema(
  {
    txnDate: { type: Date, required: true, index: true },
    amount: { type: Number, required: true },
    referenceNumber: { type: String, trim: true, default: "", index: true },
    narration: { type: String, default: "" },
    txnType: { type: String, default: "" },
    balance: { type: Number },
    transactionId: { type: String, trim: true, default: "" },
    chequeNumber: { type: String, trim: true, default: "" },
    accountNumber: { type: String, trim: true, default: "", index: true },
    utr: { type: String, trim: true, default: "", index: true },
    /** Dedupe key — hash of date + amount + reference + narration */
    entryHash: { type: String, required: true, unique: true },
    /** Composite duplicate key: account + UTR + amount + date */
    duplicateKey: { type: String, unique: true, sparse: true },
    source: {
      type: String,
      enum: ["SDK", "CORPORATE_HTTP", "MANUAL", "IMPORT"],
      default: "SDK",
    },
    reconciliationStatus: {
      type: String,
      enum: ["UNMATCHED", "MATCHED", "SUSPENSE", "IGNORED"],
      default: "UNMATCHED",
      index: true,
    },
    matchedPaymentId: { type: String, trim: true },
    rawResponse: { type: Schema.Types.Mixed },
    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

bankStatementEntrySchema.index({ accountNumber: 1, utr: 1, amount: 1, txnDate: 1 });

const BankStatementEntry =
  mongoose.models.BankStatementEntry ||
  mongoose.model("BankStatementEntry", bankStatementEntrySchema);

export default BankStatementEntry;
