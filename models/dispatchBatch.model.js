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
    /** R2 hardening days. Empty on older batches — callers fall back to 40. */
    secondaryR2PlantReadyDays: {
      type: Number,
      min: 1,
    },
    /** R3 hardening days. Empty on older batches — callers fall back to 40. */
    secondaryR3PlantReadyDays: {
      type: Number,
      min: 1,
    },
    /** CMS plant master — optional for legacy batches; required for new creates via CMS. */
    plantCmsId: {
      type: Schema.Types.ObjectId,
      ref: "PlantCms",
    },
    /** Subtype subdocument _id within PlantCms.subtypes (embedded array). */
    plantSubtypeId: {
      type: Schema.Types.ObjectId,
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
          enum: [
            "primaryPlantReadyDays",
            "secondaryPlantReadyDays",
            "secondaryR2PlantReadyDays",
            "secondaryR3PlantReadyDays",
          ],
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

