import mongoose, { Schema, model } from "mongoose";

const automationReportSchema = new Schema(
  {
    automationJobId: { type: Schema.Types.ObjectId, ref: "AutomationJob", required: true },
    total: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

automationReportSchema.index({ automationJobId: 1, createdAt: -1 });

const AutomationReport = model("AutomationReport", automationReportSchema);
export default AutomationReport;

