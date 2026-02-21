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

const campaignSchema = new Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    message: { type: String, default: "" },
    mediaIds: [{ type: Schema.Types.ObjectId, ref: "CampaignMedia" }],
    profileId: { type: Schema.Types.ObjectId, ref: "WhatsAppProfile", default: null },
    ratePerHour: { type: Number, default: 30 },
    batchSize: { type: Number, default: 30 },
    status: { type: String, enum: ["created", "active", "paused", "stopped", "completed"], default: "created" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    targets: [targetSchema],
    recipientsCount: { type: Number, default: 0 },
    duplicatesCount: { type: Number, default: 0 },
    scheduledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

campaignSchema.index({ status: 1, createdAt: -1 });

const Campaign = model("Campaign", campaignSchema);
export default Campaign;

