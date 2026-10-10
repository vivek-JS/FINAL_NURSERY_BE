import mongoose, { Schema } from "mongoose";

/**
 * cash_book — daily cash/bank movement register for ERP.
 */
const cashBookSchema = new Schema(
  {
    entryDate: { type: Date, required: true, index: true },
    entryType: {
      type: String,
      enum: ["BANK_CREDIT", "BANK_DEBIT", "CASH_IN", "CASH_OUT", "ADJUSTMENT"],
      required: true,
    },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number },
    reference: { type: String, default: "" },
    utr: { type: String, index: true },
    accountNumber: { type: String, index: true },
    narration: { type: String, default: "" },
    paymentId: { type: String, index: true },
    orderMongoId: { type: String },
    bankTransactionId: {
      type: Schema.Types.ObjectId,
      ref: "BankStatementEntry",
    },
    reconciliationId: {
      type: Schema.Types.ObjectId,
      ref: "PaymentReconciliation",
    },
    /** Pay-in slip number, for manually entered cash deposits. */
    slipNumber: { type: String, trim: true, default: "", index: true },
    /** True once the deposit was matched to a credit on the statement. */
    depositVerified: { type: Boolean, default: false, index: true },
    depositVerifiedAt: { type: Date },
    verifiedAgainstEntryId: {
      type: Schema.Types.ObjectId,
      ref: "BankStatementEntry",
    },
    /** Employee whose cash in hand this deposit came out of. */
    depositedBy: { type: Schema.Types.ObjectId, ref: "User", index: true },
    /** Photos of the stamped pay-in slip / counter receipt. */
    slipPhotos: [{ type: String, trim: true }],
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User" },
    cancelReason: { type: String, trim: true, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

cashBookSchema.index({ entryDate: 1, accountNumber: 1 });

const CashBook = mongoose.models.CashBook || mongoose.model("CashBook", cashBookSchema);

export default CashBook;
