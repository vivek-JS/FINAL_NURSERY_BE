import { Schema, model } from "mongoose";

const slotReadyRollLogSchema = new Schema(
  {
    sourceSlotId: { type: Schema.Types.ObjectId, required: true, index: true },
    targetSlotId: { type: Schema.Types.ObjectId, required: true, index: true },
    plantId: { type: Schema.Types.ObjectId, ref: "PlantCms", required: true },
    subtypeId: { type: Schema.Types.ObjectId, required: true },
    batchId: { type: Schema.Types.ObjectId, ref: "DispatchBatch" },
    secondaryInwardId: { type: Schema.Types.ObjectId },
    plantOutwardId: { type: Schema.Types.ObjectId, ref: "PlantOutward" },
    batchNumber: { type: String, default: "" },
    pollyhouse: { type: String, default: "" },
    quantityReady: { type: Number, required: true, min: 1 },
    expectedReadyDate: { type: Date },
    overdueDays: { type: Number, default: 0, min: 0 },
    rollKind: {
      type: String,
      enum: ["expired_auto", "expired_manual"],
      default: "expired_manual",
    },
    sourceSlotLabel: { type: String, default: "" },
    targetSlotLabel: { type: String, default: "" },
    reason: { type: String, default: "" },
    performedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

slotReadyRollLogSchema.index({ targetSlotId: 1, createdAt: -1 });

const SlotReadyRollLog = model("SlotReadyRollLog", slotReadyRollLogSchema);

export default SlotReadyRollLog;
