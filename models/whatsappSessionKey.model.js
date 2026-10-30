import mongoose, { Schema } from "mongoose";

/**
 * Baileys linked-device auth state (creds + signal keys), one doc per key.
 * Lives in MongoDB so deploys / restarts / wiped folders never force a new QR scan.
 * _id = `${sessionId}:${key}`
 */
const whatsappSessionKeySchema = new Schema(
  {
    _id: { type: String, required: true },
    sessionId: { type: String, required: true, index: true },
    data: { type: String, required: true },
  },
  { timestamps: true, versionKey: false, collection: "whatsapp_session_keys" }
);

const WhatsAppSessionKey =
  mongoose.models.WhatsAppSessionKey ||
  mongoose.model("WhatsAppSessionKey", whatsappSessionKeySchema);

export default WhatsAppSessionKey;
