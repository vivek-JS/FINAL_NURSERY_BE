import { Schema, model } from "mongoose";

const fifoLineSchema = new Schema(
  {
    secondaryInwardId: { type: Schema.Types.ObjectId, required: true },
    plantOutwardId: { type: Schema.Types.ObjectId, required: true },
    secondaryInwardDate: { type: Date, required: true },
    remainingPlants: { type: Number, required: true, min: 0 },
    initialPlants: { type: Number, required: true, min: 1 },
    size: { type: String, enum: ["R1", "R2", "R3"], required: false },
  },
  { _id: false },
);

const availabilityTrailSchema = new Schema(
  {
    action: { type: String, required: true },
    activityName: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0 },
    previousTotalAvailable: { type: Number, required: true, min: 0 },
    newTotalAvailable: { type: Number, required: true, min: 0 },
    reason: { type: String, default: "" },
    plantOutwardId: { type: Schema.Types.ObjectId },
    secondaryInwardId: { type: Schema.Types.ObjectId },
    secondaryOutwardId: { type: Schema.Types.ObjectId },
    performedBy: { type: Schema.Types.ObjectId, ref: "User" },
    metadata: { type: Schema.Types.Mixed },
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } },
);

const secondaryDispatchAvailabilitySchema = new Schema(
  {
    dispatchBatchId: {
      type: Schema.Types.ObjectId,
      ref: "DispatchBatch",
      required: true,
      unique: true,
      index: true,
    },
    plantOutwardId: {
      type: Schema.Types.ObjectId,
      ref: "PlantOutward",
      required: true,
    },
    totalAvailablePlants: { type: Number, default: 0, min: 0 },
    fifoLines: { type: [fifoLineSchema], default: [] },
    availabilityTrail: { type: [availabilityTrailSchema], default: [] },
  },
  { timestamps: true },
);

secondaryDispatchAvailabilitySchema.methods.recalcTotal = function recalcTotal() {
  this.totalAvailablePlants = (this.fifoLines || []).reduce(
    (sum, line) => sum + Math.max(0, Number(line.remainingPlants) || 0),
    0,
  );
  return this.totalAvailablePlants;
};

const SecondaryDispatchAvailability = model(
  "SecondaryDispatchAvailability",
  secondaryDispatchAvailabilitySchema,
);

export default SecondaryDispatchAvailability;
