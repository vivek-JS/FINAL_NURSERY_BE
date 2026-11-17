import { Schema, model } from "mongoose";

const receiptSchema = new Schema(
  {
    labOutwardId: { type: Schema.Types.ObjectId, required: true },
    bottles: { type: Number, required: true, min: 1 },
    bottlesLeft: { type: Number, required: true, min: 0 },
    plants: { type: Number, required: true, min: 0 },
    size: { type: String, required: true, enum: ["R1", "R2", "R3"] },
    outwardDate: { type: Date },
    rootingDate: { type: Date },
    receivedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const sowSchema = new Schema(
  {
    sowDate: { type: Date, required: true },
    bottlesUsed: { type: Number, required: true, min: 1 },
    size: { type: String, required: true, enum: ["R1", "R2", "R3"] },
    expectedPlants: { type: Number, required: true, min: 1 },
    mortalityExpectedPlants: { type: Number, required: true, min: 0 },
    readyDate: { type: Date, required: true },
    plantsSent: { type: Number, default: 0, min: 0 },
    laboursLadies: { type: Number, default: 0, min: 0 },
    laboursGents: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const primaryBatchLedgerSchema = new Schema(
  {
    batchId: {
      type: Schema.Types.ObjectId,
      ref: "DispatchBatch",
      required: true,
      unique: true,
    },
    bottlesReceived: { type: Number, default: 0, min: 0 },
    bottlesSown: { type: Number, default: 0, min: 0 },
    bottlesLeft: { type: Number, default: 0, min: 0 },
    expectedPlants: { type: Number, default: 0, min: 0 },
    mortalityExpectedPlants: { type: Number, default: 0, min: 0 },
    plantsSent: { type: Number, default: 0, min: 0 },
    receipts: { type: [receiptSchema], default: [] },
    sows: { type: [sowSchema], default: [] },
  },
  { timestamps: true }
);

primaryBatchLedgerSchema.index({ batchId: 1 }, { unique: true });
primaryBatchLedgerSchema.index({ "receipts.labOutwardId": 1 });

const PrimaryBatchLedger = model("PrimaryBatchLedger", primaryBatchLedgerSchema);

export default PrimaryBatchLedger;
