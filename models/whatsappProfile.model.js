import mongoose, { Schema, model } from "mongoose";

const whatsappProfileSchema = new Schema(
  {
    name: { type: String, required: true },
    userDataDir: { type: String, required: true }, // path to Chrome user-data-dir
    description: { type: String, default: "" },
    active: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

whatsappProfileSchema.index({ active: 1, createdAt: -1 });

const WhatsAppProfile = model("WhatsAppProfile", whatsappProfileSchema);
export default WhatsAppProfile;

