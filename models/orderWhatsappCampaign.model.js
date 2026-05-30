import mongoose, { Schema } from "mongoose";

const orderWhatsappCampaignSchema = new Schema(
  {
    batchId: {
      type: String,
      trim: true,
      required: true,
      unique: true,
      index: true,
    },
    campaignName: {
      type: String,
      trim: true,
      required: true,
    },
    templateType: {
      type: String,
      enum: ["farm_ready"],
      default: "farm_ready",
    },
    plannedCount: {
      type: Number,
      default: 0,
    },
    sentBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

orderWhatsappCampaignSchema.index({ createdAt: -1 });
orderWhatsappCampaignSchema.index({ templateType: 1, createdAt: -1 });

const OrderWhatsappCampaign =
  mongoose.models.OrderWhatsappCampaign ||
  mongoose.model("OrderWhatsappCampaign", orderWhatsappCampaignSchema);

export default OrderWhatsappCampaign;
