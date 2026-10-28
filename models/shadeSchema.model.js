import { Schema, model } from "mongoose";

const shadeSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    number: {
      type: String,
      required: true,
      unique: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    is_primary: {
      type: Boolean,
      default: false,
    },
    /** Max plants if this shed is entirely that crop. Melon is watermelon and muskmelon together. */
    smartCapacity: {
      papaya: { type: Number, min: 0, default: 0 },
      melon: { type: Number, min: 0, default: 0 },
    },
  },
  {
    timestamps: true,
  }
);

const Shade = model("Shade", shadeSchema);

export default Shade;
