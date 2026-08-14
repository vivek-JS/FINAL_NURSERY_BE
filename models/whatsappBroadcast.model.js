import mongoose from "mongoose";
const { Schema, model } = mongoose;

const contactSchema = new Schema(
  {
    phone: { type: String, required: true, trim: true },
    name: { type: String, trim: true, default: "" },
    farmerId: { type: Schema.Types.ObjectId, ref: "Farmer", required: false },
    leadId: { type: Schema.Types.ObjectId, ref: "FarmerLead", required: false },
    status: { type: String, enum: ["pending", "sent", "delivered", "read", "failed"], default: "pending" },
    localMessageId: { type: String, default: null },
    whatsappMessageId: { type: String, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    replyText: { type: String, default: null },
    repliedAt: { type: Date, default: null },
  },
  { _id: false }
);

const whatsappBroadcastSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    templateName: { type: String, required: false },
    contacts: [contactSchema],
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: false },
    sentAt: { type: Date, default: Date.now },
    status: { type: String, enum: ["created", "sent", "completed", "paused"], default: "created" },
    meta: { type: Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
);

whatsappBroadcastSchema.index({ name: 1 });
whatsappBroadcastSchema.index({ sentAt: -1 });

const WhatsAppBroadcast = model("WhatsAppBroadcast", whatsappBroadcastSchema);
export default WhatsAppBroadcast;

