import mongoose from "mongoose";

const rewardProgressSchema = new mongoose.Schema(
  {
    program: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RewardProgram",
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    manualAdjustment: { type: Number, default: 0 },
    computedPoints: { type: Number, default: 0 },
    lastComputedAt: { type: Date, default: null },
    notes: { type: String, default: "", trim: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

rewardProgressSchema.index({ program: 1, user: 1 }, { unique: true });
rewardProgressSchema.index({ user: 1 });

const RewardProgress = mongoose.model("RewardProgress", rewardProgressSchema);

export default RewardProgress;
