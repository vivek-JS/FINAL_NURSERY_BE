import mongoose from "mongoose";

const oldSalesChangeLogSchema = new mongoose.Schema(
  {
    field: { type: String, required: true, trim: true },
    fromValue: { type: String, trim: true },
    toValue: { type: String, trim: true },
    similarity: { type: Number },
    warning: { type: Boolean, default: false },
    scope: { type: String, enum: ["bulk", "single"], default: "bulk" },
    affectedCount: { type: Number, default: 0 },
    reason: { type: String, trim: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true, collection: "old_sales_change_logs" }
);

oldSalesChangeLogSchema.index({ field: 1, createdAt: -1 });
oldSalesChangeLogSchema.index({ changedBy: 1, createdAt: -1 });

const OldSalesChangeLog = mongoose.model(
  "OldSalesChangeLog",
  oldSalesChangeLogSchema
);

export default OldSalesChangeLog;
