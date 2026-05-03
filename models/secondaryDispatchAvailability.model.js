import { Schema, model } from "mongoose";

/**
 * Audit trail for secondary-stage physical stock (mirrors slotTrail intent in slots.model.js).
 */
const availabilityTrailSchema = new Schema(
  {
    action: {
      type: String,
      enum: ["ADD_SECONDARY_INWARD", "SUBTRACT_SECONDARY_OUTWARD", "ADJUST"],
      required: true,
    },
    activityName: { type: String, default: "" },
    quantity: { type: Number, required: true },
    previousTotalAvailable: { type: Number, required: true },
    newTotalAvailable: { type: Number, required: true },
    reason: { type: String, required: true },
    plantOutwardId: { type: Schema.Types.ObjectId, ref: "PlantOutward" },
    secondaryInwardId: { type: Schema.Types.ObjectId },
    secondaryOutwardId: { type: Schema.Types.ObjectId },
    performedBy: { type: Schema.Types.ObjectId, ref: "User" },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

/**
 * FIFO layer per secondary inward line (oldest secondaryInwardDate first in fifoLines).
 * remainingPlants tracks what is still available to dispatch from this layer.
 */
const fifoLineSchema = new Schema(
  {
    secondaryInwardId: { type: Schema.Types.ObjectId, required: true },
    plantOutwardId: { type: Schema.Types.ObjectId, ref: "PlantOutward", required: true },
    secondaryInwardDate: { type: Date, required: true },
    remainingPlants: { type: Number, required: true, min: 0 },
    initialPlants: { type: Number, required: true, min: 1 },
    size: { type: String, enum: ["R1", "R2", "R3"] },
  },
  { _id: false }
);

const secondaryDispatchAvailabilitySchema = new Schema(
  {
    /** Dispatch batch — one ledger document per batch */
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
    /** Sum of fifoLines[].remainingPlants */
    totalAvailablePlants: { type: Number, default: 0, min: 0 },
    fifoLines: { type: [fifoLineSchema], default: [] },
    availabilityTrail: { type: [availabilityTrailSchema], default: [] },
  },
  { timestamps: true }
);

secondaryDispatchAvailabilitySchema.methods.recalcTotal = function recalcTotal() {
  this.totalAvailablePlants = (this.fifoLines || []).reduce(
    (s, line) => s + (line.remainingPlants || 0),
    0
  );
};

/** Cap trail length similar to slots.model.js pattern */
secondaryDispatchAvailabilitySchema.pre("save", function (next) {
  if (this.availabilityTrail && this.availabilityTrail.length > 1000) {
    this.availabilityTrail = this.availabilityTrail.slice(0, 1000);
  }
  next();
});

const SecondaryDispatchAvailability = model(
  "SecondaryDispatchAvailability",
  secondaryDispatchAvailabilitySchema,
  "secondary_dispatch_availability"
);

export default SecondaryDispatchAvailability;
