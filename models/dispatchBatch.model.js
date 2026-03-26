import { Schema, model } from "mongoose";

const dispatchBatchSchema = new Schema(
  {
    batchNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    dateAdded: {
      type: Date,
      required: true,
      default: Date.now,
    },
    primaryPlantReadyDays: {
      type: Number,
      required: true,
      min: 1,
    },
    secondaryPlantReadyDays: {
      type: Number,
      required: true,
      min: 1,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    plantReadyDaysAudit: [
      {
        changedAt: { type: Date, default: Date.now },
        changedBy: { type: Schema.Types.ObjectId, ref: "User" },
        field: {
          type: String,
          enum: ["primaryPlantReadyDays", "secondaryPlantReadyDays"],
        },
        oldValue: { type: Number },
        newValue: { type: Number },
        reason: { type: String, trim: true },
      },
    ],
  },
  {
    timestamps: true,
  }
);

dispatchBatchSchema.index({ batchNumber: 1 }, { unique: true });

const DispatchBatch = model("DispatchBatch", dispatchBatchSchema);

export default DispatchBatch;

