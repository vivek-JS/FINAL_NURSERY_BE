import mongoose from "mongoose";

const ramAgriDailyClosingStockSchema = new mongoose.Schema(
  {
    /** Calendar date IST — stored as YYYY-MM-DD for one row per variety per day */
    stockDate: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    cropId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RamAgriInputsProduct",
      required: true,
    },
    varietyId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    cropName: { type: String, trim: true, default: "" },
    varietyName: { type: String, trim: true, default: "" },
    productType: {
      type: String,
      enum: ["seed", "chemical"],
      default: "seed",
    },
    closingStock: {
      type: Number,
      required: true,
      min: 0,
    },
    /** Live system stock at time of save (reference only) */
    systemStockAtSave: {
      type: Number,
      min: 0,
      default: 0,
    },
    primaryUnitLabel: { type: String, trim: true, default: "" },
    notes: { type: String, trim: true, default: "" },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

ramAgriDailyClosingStockSchema.index(
  { stockDate: 1, cropId: 1, varietyId: 1 },
  { unique: true }
);
ramAgriDailyClosingStockSchema.index({ stockDate: -1 });

export default mongoose.model(
  "RamAgriDailyClosingStock",
  ramAgriDailyClosingStockSchema
);
