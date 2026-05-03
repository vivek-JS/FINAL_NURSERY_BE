import { Schema, model } from "mongoose";

const nurserySiteSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    /** Short code shown on forms, e.g. RB, GH, SB */
    code: { type: String, required: true, trim: true, uppercase: true },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

nurserySiteSchema.index({ code: 1 }, { unique: true });
nurserySiteSchema.index({ isActive: 1, sortOrder: 1 });

export default model("NurserySite", nurserySiteSchema);
