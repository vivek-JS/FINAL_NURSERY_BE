import mongoose, { Schema, model } from "mongoose";

const followUpSchema = new Schema(
  {
    farmerId: { type: Schema.Types.ObjectId, ref: "Farmer", required: true, index: true },
    phone: { type: String, required: true, index: true },
    scheduledAt: { type: Date, required: true },
    status: { type: String, enum: ["pending", "completed", "canceled"], default: "pending" },
    source: { type: String, default: null },
    assignedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

const FollowUp = model("FollowUp", followUpSchema);
export default FollowUp;

