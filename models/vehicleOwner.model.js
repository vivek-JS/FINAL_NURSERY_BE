import { Schema, model } from "mongoose";

const vehicleOwnerSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    mobile: {
      type: String,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

vehicleOwnerSchema.index({ name: 1 });
vehicleOwnerSchema.index({ isActive: 1 });

export default model("VehicleOwner", vehicleOwnerSchema);
