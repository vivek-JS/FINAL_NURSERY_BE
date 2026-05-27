import mongoose from "mongoose";

const ledgerReconciliationRunSchema = new mongoose.Schema(
  {
    tenantId: { type: String, default: "default", index: true },
    runDate: { type: Date, required: true, index: true },
    domain: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["RUNNING", "PASSED", "FAILED"],
      default: "RUNNING",
    },
    totalChecked: { type: Number, default: 0 },
    mismatchCount: { type: Number, default: 0 },
    mismatches: [
      {
        partyType: String,
        partyId: String,
        centralBalance: Number,
        subLedgerBalance: Number,
        delta: Number,
        notes: String,
      },
    ],
    completedAt: { type: Date },
  },
  { timestamps: true }
);

const LedgerReconciliationRun =
  mongoose.models.LedgerReconciliationRun ||
  mongoose.model("LedgerReconciliationRun", ledgerReconciliationRunSchema);

export default LedgerReconciliationRun;
