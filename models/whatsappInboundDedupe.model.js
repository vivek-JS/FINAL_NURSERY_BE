import mongoose, { Schema } from "mongoose";

/** Prevents duplicate WATI inbound processing when multiple webhooks receive the same event. */
const whatsappInboundDedupeSchema = new Schema(
  {
    dedupeKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    messageId: { type: String, trim: true, default: null },
    mobile10: { type: String, trim: true, default: null },
    flow: { type: String, trim: true, default: "farm_ready" },
    action: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

whatsappInboundDedupeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

const WhatsappInboundDedupe =
  mongoose.models.WhatsappInboundDedupe ||
  mongoose.model("WhatsappInboundDedupe", whatsappInboundDedupeSchema);

export default WhatsappInboundDedupe;
