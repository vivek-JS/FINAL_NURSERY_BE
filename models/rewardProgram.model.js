import mongoose from "mongoose";

const REWARD_AUDIENCE_ROLES = [
  "DEALER",
  "SALES",
  "RAM_AGRI_SALES",
  "RAM_AGRI_SALES_MANAGER",
  "RAM_AGRI_SALES_OFFICE_MANAGER",
  "AGRI_INPUT_DEALER",
];

const REWARD_THEMES = ["joy", "cool", "sunrise"];
const REWARD_IMAGE_KEYS = ["trophy", "star", "medal", "rocket"];
const REWARD_PROGRESS_METRICS = ["manual", "order_count", "plants_sold", "order_value"];

const milestoneSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    target: { type: Number, required: true, min: 0 },
    reward: { type: String, default: "", trim: true },
    imageKey: {
      type: String,
      enum: REWARD_IMAGE_KEYS,
      default: "medal",
    },
  },
  { _id: true }
);

const rewardProgramSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    audienceLabel: { type: String, default: "", trim: true },
    targetRoles: {
      type: [String],
      enum: REWARD_AUDIENCE_ROLES,
      default: ["DEALER"],
    },
    theme: { type: String, enum: REWARD_THEMES, default: "joy" },
    unit: { type: String, default: "points", trim: true },
    progressMetric: {
      type: String,
      enum: REWARD_PROGRESS_METRICS,
      default: "order_count",
    },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    milestones: { type: [milestoneSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

rewardProgramSchema.index({ isActive: 1, targetRoles: 1 });

const RewardProgram = mongoose.model("RewardProgram", rewardProgramSchema);

export {
  REWARD_AUDIENCE_ROLES,
  REWARD_THEMES,
  REWARD_IMAGE_KEYS,
  REWARD_PROGRESS_METRICS,
};
export default RewardProgram;
