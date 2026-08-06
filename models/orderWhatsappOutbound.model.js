import mongoose, { Schema } from "mongoose";

const orderWhatsappOutboundSchema = new Schema(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    publicOrderCode: {
      type: String,
      trim: true,
      default: null,
    },
    farmerName: {
      type: String,
      trim: true,
      default: null,
    },
    farmerMobile10: {
      type: String,
      trim: true,
      default: null,
    },
    templateType: {
      type: String,
      enum: ["farm_ready", "order_placed", "payment_collected", "order_accepted", "dispatch"],
      default: "farm_ready",
    },
    localMessageId: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
    whatsappMessageId: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
    /** WATI webhook `id` (hex) — often differs from send API localMessageId UUID. */
    watiWebhookId: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "sent", "delivered", "read", "failed"],
      default: "pending",
      index: true,
    },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    failedCode: { type: String, trim: true, default: null },
    failedDetail: { type: String, trim: true, default: null },
    farmerReplyText: { type: String, trim: true, default: null },
    farmerReplyAction: { type: String, trim: true, default: null },
    farmerReplyAt: { type: Date, default: null },
    farmerReplyMessageId: { type: String, trim: true, default: null },
    sentBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    trigger: {
      type: String,
      trim: true,
      default: null,
    },
    batchId: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
    campaignName: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { timestamps: true }
);

orderWhatsappOutboundSchema.index({ orderId: 1, createdAt: -1 });
orderWhatsappOutboundSchema.index({ status: 1, createdAt: -1 });
orderWhatsappOutboundSchema.index({ batchId: 1, createdAt: -1 });

const OrderWhatsappOutbound =
  mongoose.models.OrderWhatsappOutbound ||
  mongoose.model("OrderWhatsappOutbound", orderWhatsappOutboundSchema);

export default OrderWhatsappOutbound;
