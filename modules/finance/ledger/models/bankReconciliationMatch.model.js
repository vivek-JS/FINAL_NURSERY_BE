import mongoose from "mongoose";

const bankReconciliationMatchSchema = new mongoose.Schema(
  {
    tenantId: { type: String, default: "default", index: true },
    statementLineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankStatementEntry",
      required: true,
      index: true,
    },
    journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry" },
    paymentId: { type: String, trim: true },
    orderMongoId: { type: String, trim: true },
    source: { type: String, enum: ["order", "agriSales"], trim: true },
    matchRule: { type: String, trim: true },
    matchScore: { type: Number },
    matchedAt: { type: Date, default: Date.now },
    matchedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

bankReconciliationMatchSchema.index(
  { tenantId: 1, statementLineId: 1 },
  { unique: true }
);

const BankReconciliationMatch =
  mongoose.models.BankReconciliationMatch ||
  mongoose.model("BankReconciliationMatch", bankReconciliationMatchSchema);

export default BankReconciliationMatch;
