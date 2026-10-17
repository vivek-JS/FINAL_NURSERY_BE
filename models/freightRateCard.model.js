import { Schema, model } from "mongoose";

export const FREIGHT_SLAB_CONDITIONS = ["BELOW", "ABOVE", "BETWEEN", "AT_LEAST"];

const slabSchema = new Schema(
  {
    crop: { type: String, required: true, trim: true },
    /**
     * BELOW: crates < value · ABOVE: crates > value
     * BETWEEN: from <= crates <= to · AT_LEAST: crates >= value
     */
    condition: { type: String, enum: FREIGHT_SLAB_CONDITIONS, required: true },
    value: { type: Number, default: null, min: 0 },
    from: { type: Number, default: null, min: 0 },
    to: { type: Number, default: null, min: 0 },
    ratePerKm: { type: Number, required: true, min: 0 },
  },
  { _id: true }
);

const loadTypeSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    sortOrder: { type: Number, default: 0 },
    slabs: { type: [slabSchema], default: [] },
  },
  { _id: true }
);

const freightRateCardSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    loadTypes: { type: [loadTypeSchema], default: [] },
    /** Local market delivery: ₹ per plant instead of per-km slab. */
    localMarketRatePerPlant: { type: Number, default: 0.5, min: 0 },
    /** Optional flat per-km rate when trip distance is below shortTripMaxKm. */
    shortTripMaxKm: { type: Number, default: null, min: 0 },
    shortTripRatePerKm: { type: Number, default: null, min: 0 },
    notes: { type: String, trim: true, default: "" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

freightRateCardSchema.index({ code: 1 }, { unique: true });
freightRateCardSchema.index({ isActive: 1, sortOrder: 1 });

export default model("FreightRateCard", freightRateCardSchema);
