import mongoose from "mongoose";
import { ACCOUNT_TYPES } from "../../domain/constants.js";

const chartOfAccountSchema = new mongoose.Schema(
  {
    tenantId: { type: String, default: "default", index: true },
    code: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    accountType: {
      type: String,
      enum: Object.values(ACCOUNT_TYPES),
      required: true,
    },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: "ChartOfAccount" },
    branchScope: { type: String, enum: ["ALL", "BRANCH_ONLY"], default: "ALL" },
    gstApplicable: { type: Boolean, default: false },
    isControl: { type: Boolean, default: false },
    partyType: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

chartOfAccountSchema.index({ tenantId: 1, code: 1 }, { unique: true });

const ChartOfAccount =
  mongoose.models.ChartOfAccount ||
  mongoose.model("ChartOfAccount", chartOfAccountSchema);

export default ChartOfAccount;
