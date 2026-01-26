import mongoose from "mongoose";
const { Schema, model } = mongoose;

const farmerListSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, "List name is required"],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    farmers: [
      {
        type: Schema.Types.ObjectId,
        ref: "Farmer",
        required: true,
      },
    ],
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: false, // Optional for now
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

// Index for faster lookups
farmerListSchema.index({ name: 1 });
farmerListSchema.index({ createdBy: 1 });
farmerListSchema.index({ isActive: 1 });

const FarmerList = model("FarmerList", farmerListSchema);
export default FarmerList;
