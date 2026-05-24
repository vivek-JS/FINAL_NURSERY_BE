import mongoose from "mongoose";

const dealerCommissionSettlementSchema = new mongoose.Schema(
  {
    dealer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: "INR",
    },
    periodStart: {
      type: Date,
    },
    periodEnd: {
      type: Date,
    },
    expectedCommission: {
      type: Number,
      default: 0,
    },
    actualCommission: {
      type: Number,
      default: 0,
    },
    alreadySettled: {
      type: Number,
      default: 0,
    },
    settledAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    breakdown: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    ledgerEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DealerLedgerEntry",
    },
    walletBalanceAfter: {
      type: Number,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    remark: {
      type: String,
      trim: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

dealerCommissionSettlementSchema.index({ dealer: 1, createdAt: -1 });

const DealerCommissionSettlement = mongoose.model(
  "DealerCommissionSettlement",
  dealerCommissionSettlementSchema
);

export default DealerCommissionSettlement;
