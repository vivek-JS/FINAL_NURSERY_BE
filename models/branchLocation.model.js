import { Schema, model } from "mongoose";

const branchLocationSchema = new Schema(
  {
    branch_id: {
      type: Schema.Types.ObjectId,
      ref: "NurserySite",
      required: true,
      unique: true,
    },
    latitude: {
      type: Number,
      required: true,
    },
    longitude: {
      type: Number,
      required: true,
    },
    allowed_radius_meters: {
      type: Number,
      default: 200,
      min: 10,
    },
    max_gps_accuracy_meters: {
      type: Number,
      default: 50,
      min: 1,
    },
    is_attendance_enabled: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

const BranchLocation = model("BranchLocation", branchLocationSchema);

export default BranchLocation;
