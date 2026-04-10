// vehicleModel.js
import { Schema, model } from "mongoose";

const vehicleSchema = new Schema(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "VehicleOwner",
      index: true,
    },
    defaultDriverId: {
      type: Schema.Types.ObjectId,
      ref: "VehicleDriver",
    },
    name: {
      type: String,
      required: true,
    },
    number: {
      type: String,
      required: true,
      unique: true,
    },
    capacity: {
      type: Number,
      required: true,
      min: 1,
      default: 0,
    },
    // Driver Information
    driverName: {
      type: String,
      trim: true,
    },
    driverMobile: {
      type: String,
      trim: true,
    },
    vehicleType: {
      type: String,
      enum: ["TRUCK", "TEMPO", "PICKUP", "TRACTOR", "OTHER"],
      default: "TRUCK",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

export default model("Vehicle", vehicleSchema);
