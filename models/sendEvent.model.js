import mongoose, { Schema, model } from "mongoose";

const sendEventSchema = new Schema(
  {
    automationJobId: { type: Schema.Types.ObjectId, ref: "AutomationJob", required: false },
    campaignId: { type: Schema.Types.ObjectId, ref: "Campaign", required: false },
    farmerId: { type: Schema.Types.ObjectId, ref: "Farmer", required: false },
    phone: { type: String, required: true },
    name: { type: String, default: null },
    message: { type: String, default: null },
    status: { type: String, enum: ["sent", "failed", "skipped"], required: true },
    error: { type: String, default: null },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

sendEventSchema.index({ automationJobId: 1, farmerId: 1, phone: 1, timestamp: -1 });

const SendEvent = model("SendEvent", sendEventSchema);
export default SendEvent;

