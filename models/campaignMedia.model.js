import mongoose, { Schema, model } from "mongoose";

const campaignMediaSchema = new Schema(
  {
    filename: { type: String, required: true },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    storagePath: { type: String, required: true },
    url: { type: String, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

campaignMediaSchema.index({ uploadedBy: 1, createdAt: -1 });

const CampaignMedia = model("CampaignMedia", campaignMediaSchema);
export default CampaignMedia;

