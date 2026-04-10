import { Schema, model } from "mongoose";

const vehicleDriverSchema = new Schema(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "VehicleOwner",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    mobile: {
      type: String,
      trim: true,
    },
    licenseNumber: {
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

vehicleDriverSchema.index({ ownerId: 1, name: 1 });

export default model("VehicleDriver", vehicleDriverSchema);
