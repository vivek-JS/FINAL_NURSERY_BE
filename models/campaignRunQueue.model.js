import mongoose, { Schema, model } from "mongoose";

const campaignRunQueueSchema = new Schema(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: "Campaign", required: true },
    delaySeconds: { type: Number, default: 10 },
    status: { type: String, enum: ["pending", "running", "completed", "failed", "cancelled"], default: "pending" },
    claimedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    workerId: { type: String, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

campaignRunQueueSchema.index({ status: 1, createdAt: 1 });

const CampaignRunQueue = model("CampaignRunQueue", campaignRunQueueSchema);
export default CampaignRunQueue;
