import { Schema, model } from "mongoose";

const batchSchema = new Schema(
  {
    batchNumber: {
      type: String,
      required: true,
      unique: true,
    },
    dateAdded: {
      type: Date,
      required: true,
      default: Date.now,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    primaryPlantReadyDays: {
      type: Number,
      // required: true
    },
    secondaryPlantReadyDays: {
      type: Number,
      //required: true
    },
  },
  {
    timestamps: true,
  }
);

const Batch = model("Batch", batchSchema);

export default Batch;
