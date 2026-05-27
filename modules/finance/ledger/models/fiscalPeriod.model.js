import mongoose from "mongoose";

const fiscalPeriodSchema = new mongoose.Schema(
  {
    tenantId: { type: String, default: "default", index: true },
    periodKey: { type: String, required: true, trim: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    isClosed: { type: Boolean, default: false },
    closedAt: { type: Date },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

fiscalPeriodSchema.index({ tenantId: 1, periodKey: 1 }, { unique: true });

const FiscalPeriod =
  mongoose.models.FiscalPeriod ||
  mongoose.model("FiscalPeriod", fiscalPeriodSchema);

export default FiscalPeriod;
