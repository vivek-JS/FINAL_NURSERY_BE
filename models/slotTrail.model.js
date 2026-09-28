import mongoose from "mongoose";

/**
 * Slot activity history lives here, not on PlantSlot.
 * One PlantSlot document holds every subtype and day for a plant-year.
 * Embedding trails in that document crosses MongoDB's 16MB limit.
 */
const slotTrailSchema = new mongoose.Schema(
  {
    plantSlotId: { type: mongoose.Schema.Types.ObjectId, index: true },
    plantId: { type: mongoose.Schema.Types.ObjectId, index: true },
    year: { type: Number },
    subtypeId: { type: mongoose.Schema.Types.ObjectId, index: true },
    slotId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    startDay: { type: String },
    endDay: { type: String },
    action: { type: String, index: true },
    entry: { type: mongoose.Schema.Types.Mixed, required: true },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

slotTrailSchema.index({ slotId: 1, createdAt: -1 });
slotTrailSchema.index({ plantId: 1, createdAt: -1 });

const SlotTrail = mongoose.model("SlotTrail", slotTrailSchema);
export default SlotTrail;
