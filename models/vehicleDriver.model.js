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
    /** Payout / bank details for driver settlements */
    bankName: {
      type: String,
      trim: true,
      default: "",
    },
    accountNumber: {
      type: String,
      trim: true,
      default: "",
    },
    ifscCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },
    paymentAccountPhotoUrl: {
      type: String,
      trim: true,
      default: "",
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
