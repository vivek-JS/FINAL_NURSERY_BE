import { Schema, model } from "mongoose";

/** Singleton-style config for Ram Agri sales credit limits (one logical row). */
const ramAgriSalesConfigSchema = new Schema(
  {
    /** Fixed key so we always upsert/read the same document */
    key: {
      type: String,
      default: "default",
      unique: true,
      immutable: true,
    },
    /** Default outstanding cap (₹) when User has no per-user override */
    defaultOutstandingLimitRupees: {
      type: Number,
      default: 10000,
      min: 0,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

const RamAgriSalesConfig = model("RamAgriSalesConfig", ramAgriSalesConfigSchema);

export default RamAgriSalesConfig;
