import mongoose from "mongoose";

/** Atomic voucher / journal sequence counters (avoids duplicate voucherNo under concurrent post). */
const financeSequenceSchema = new mongoose.Schema(
  {
    tenantId: { type: String, default: "default", required: true },
    key: { type: String, required: true, trim: true },
    seq: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

financeSequenceSchema.index({ tenantId: 1, key: 1 }, { unique: true });

const FinanceSequence =
  mongoose.models.FinanceSequence ||
  mongoose.model("FinanceSequence", financeSequenceSchema);

export default FinanceSequence;
