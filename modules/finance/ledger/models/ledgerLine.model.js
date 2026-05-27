import mongoose from "mongoose";

const ledgerLineSchema = new mongoose.Schema(
  {
    tenantId: { type: String, default: "default", index: true },
    journalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JournalEntry",
      required: true,
      index: true,
    },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChartOfAccount",
      required: true,
      index: true,
    },
    accountCode: { type: String, required: true, trim: true },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    branchId: { type: String, default: "default", index: true },
    entryDate: { type: Date, required: true, index: true },
    partyType: { type: String, trim: true },
    partyId: { type: String, trim: true },
    sourceLineRef: { type: String, trim: true },
    reversalOfLineId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerLine" },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

ledgerLineSchema.index({ tenantId: 1, branchId: 1, entryDate: 1, accountId: 1 });
ledgerLineSchema.index({ tenantId: 1, partyType: 1, partyId: 1, entryDate: 1 });

ledgerLineSchema.pre("validate", function (next) {
  const debit = Number(this.debit || 0);
  const credit = Number(this.credit || 0);
  if (debit <= 0 && credit <= 0) {
    return next(new Error("Ledger line must have debit or credit"));
  }
  if (debit > 0 && credit > 0) {
    return next(new Error("Ledger line cannot have both debit and credit"));
  }
  next();
});

const immutableOps = [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "findByIdAndUpdate",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
  "findByIdAndDelete",
];
immutableOps.forEach((op) => {
  ledgerLineSchema.pre(op, function (next) {
    next(new Error("Ledger lines are immutable. Create a reversal journal instead."));
  });
});

const LedgerLine =
  mongoose.models.LedgerLine || mongoose.model("LedgerLine", ledgerLineSchema);

export default LedgerLine;
