import { Schema, model } from "mongoose";

const transferSnapshotSchema = new Schema(
  {
    primarySowed: { type: Number, default: 0 },
    plantsSowed: { type: Number, default: 0 },
    officeSowed: { type: Number, default: 0 },
    totalBookedPlants: { type: Number, default: 0 },
  },
  { _id: false }
);

const slotTransferSchema = new Schema(
  {
    plantId: { type: Schema.Types.ObjectId, ref: "PlantCms", required: true },
    plantName: { type: String, default: "" },
    sourceSlotId: { type: Schema.Types.ObjectId, required: true },
    sourceSubtypeId: { type: Schema.Types.ObjectId, required: true },
    sourceSubtypeName: { type: String, default: "" },
    targetSlotId: { type: Schema.Types.ObjectId, required: true },
    targetSubtypeId: { type: Schema.Types.ObjectId, required: true },
    targetSubtypeName: { type: String, default: "" },
    quantity: { type: Number, required: true, min: 1 },
    reason: { type: String, default: "" },
    performedBy: { type: Schema.Types.ObjectId, ref: "User" },
    sourceBefore: { type: transferSnapshotSchema, default: () => ({}) },
    sourceAfter: { type: transferSnapshotSchema, default: () => ({}) },
    targetBefore: { type: transferSnapshotSchema, default: () => ({}) },
    targetAfter: { type: transferSnapshotSchema, default: () => ({}) },
    metadata: {
      type: new Schema(
        {
          sourceSlotStartDay: String,
          sourceSlotEndDay: String,
          targetSlotStartDay: String,
          targetSlotEndDay: String,
          daysDifference: Number,
        },
        { _id: false }
      ),
      default: () => ({}),
    },
  },
  { timestamps: true }
);

const SlotTransferLog = model("SlotTransferLog", slotTransferSchema);

export default SlotTransferLog;

