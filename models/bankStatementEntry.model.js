import mongoose, { Schema } from "mongoose";

/**
 * Normalised ICICI bank statement lines for ERP reconciliation.
 * Dedupe by entryHash when inserting.
 */
const bankStatementEntrySchema = new Schema(
  {
    txnDate: { type: Date, required: true, index: true },
    amount: { type: Number, required: true },
    referenceNumber: { type: String, trim: true, default: "" },
    narration: { type: String, default: "" },
    txnType: { type: String, default: "" },
    balance: { type: Number },
    transactionId: { type: String, trim: true, default: "" },
    chequeNumber: { type: String, trim: true, default: "" },
    /** Dedupe key — hash of date + amount + reference + narration */
    entryHash: { type: String, required: true, unique: true },
    rawResponse: { type: Schema.Types.Mixed },
    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const BankStatementEntry =
  mongoose.models.BankStatementEntry ||
  mongoose.model("BankStatementEntry", bankStatementEntrySchema);

export default BankStatementEntry;
