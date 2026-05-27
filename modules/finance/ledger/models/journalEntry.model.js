import mongoose from "mongoose";

const journalEntrySchema = new mongoose.Schema(
  {
    tenantId: { type: String, default: "default", index: true },
    journalNo: { type: String, required: true, trim: true },
    voucherId: { type: mongoose.Schema.Types.ObjectId, ref: "FinanceVoucher", required: true },
    entryDate: { type: Date, required: true, index: true },
    fiscalPeriod: { type: String, trim: true, index: true },
    branchId: { type: String, default: "default", index: true },
    totalDebit: { type: Number, required: true },
    totalCredit: { type: Number, required: true },
    isBalanced: { type: Boolean, default: true },
    reversalOfJournalId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry" },
    description: { type: String, trim: true },
    postedAt: { type: Date, default: Date.now },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

journalEntrySchema.index({ tenantId: 1, journalNo: 1 }, { unique: true });
journalEntrySchema.index({ tenantId: 1, entryDate: 1, branchId: 1 });

const JournalEntry =
  mongoose.models.JournalEntry ||
  mongoose.model("JournalEntry", journalEntrySchema);

export default JournalEntry;
