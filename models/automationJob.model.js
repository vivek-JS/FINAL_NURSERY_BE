import mongoose, { Schema, model } from "mongoose";

const targetSchema = new Schema({
  name: { type: String, default: null },
  phone: { type: String, required: true },
  farmerId: { type: Schema.Types.ObjectId, ref: "Farmer", default: null },
  message: { type: String, default: null },
  status: { type: String, enum: ["pending", "sent", "skipped", "error"], default: "pending" },
  attempts: { type: Number, default: 0 },
  lastAttemptAt: { type: Date, default: null },
  lastError: { type: String, default: null },
  normalizedPhone: { type: String, default: null, index: true },
});

const automationJobSchema = new Schema(
  {
    name: { type: String, required: true },
    message: { type: String, default: "" },
    mode: { type: String, enum: ["rate", "immediate"], default: "immediate" },
    ratePerHour: { type: Number, default: 30 },
    ratePer2Min: { type: Number, default: 1 }, // messages per 2 minutes (1 = 1 msg every 2 min)
    batchSize: { type: Number, default: 30 },
    status: { type: String, enum: ["created", "active", "paused", "completed"], default: "created" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    mediaIds: [{ type: Schema.Types.ObjectId, ref: "CampaignMedia" }],
    profileId: { type: Schema.Types.ObjectId, ref: "WhatsAppProfile", default: null },
    schedule: { type: Schema.Types.Mixed, default: null }, // { type, ratePerHour, intervalMs, startAt, endAt }
    maxPerRun: { type: Number, default: null },
    campaignId: { type: Schema.Types.ObjectId, ref: "Campaign", default: null },
    targets: [targetSchema],
  },
  { timestamps: true }
);

automationJobSchema.index({ status: 1, createdAt: 1 });

const AutomationJob = model("AutomationJob", automationJobSchema);
export default AutomationJob;


