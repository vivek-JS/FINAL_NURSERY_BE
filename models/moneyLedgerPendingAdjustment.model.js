import mongoose from "mongoose";

/**
 * Party-level Money Ledger Payment / Discount awaiting accountant acceptance.
 * Posted to MoneyLedgerEntry only after APPROVED.
 */
const moneyLedgerPendingAdjustmentSchema = new mongoose.Schema(
  {
    book: {
      type: String,
      enum: ["BIOTECH", "RAM_AGRI"],
      required: true,
      index: true,
    },
    partyType: {
      type: String,
      enum: ["MERCHANT", "SUPPLIER"],
      required: true,
      index: true,
    },
    partyId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    partyName: { type: String, trim: true, default: "" },
    kind: {
      type: String,
      enum: ["PAYMENT", "DISCOUNT"],
      required: true,
      index: true,
    },
    amount: { type: Number, required: true, min: 0.01 },
    direction: {
      type: String,
      enum: ["AUTO", "COLLECT", "PAY"],
      default: "AUTO",
    },
    entryDate: { type: Date, default: Date.now, index: true },
    modeOfPayment: { type: String, trim: true, default: "" },
    remark: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
      index: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    rejectReason: { type: String, trim: true, default: "" },
    ledgerEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "MoneyLedgerEntry" },
  },
  { timestamps: true }
);

moneyLedgerPendingAdjustmentSchema.index({ book: 1, status: 1, createdAt: -1 });

export default mongoose.model(
  "MoneyLedgerPendingAdjustment",
  moneyLedgerPendingAdjustmentSchema
);
