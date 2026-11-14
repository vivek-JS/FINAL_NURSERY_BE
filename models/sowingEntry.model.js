import { Schema, model } from "mongoose";

/**
 * One sowing entry. Variety is a field, not a separate collection.
 * Cover and linked orders live on this document. No slot link.
 */
const sowingEntrySchema = new Schema(
  {
    sourceBatchId: { type: Schema.Types.ObjectId, required: true, unique: true },
    sowingRequestId: { type: Schema.Types.ObjectId, ref: "SowingRequest", index: true },
    requestNumber: { type: String, default: "", trim: true, index: true },
    plantId: { type: Schema.Types.ObjectId, ref: "PlantCms", required: true, index: true },
    plantName: { type: String, default: "", trim: true },
    subtypeId: { type: Schema.Types.ObjectId, index: true },
    subtypeName: { type: String, default: "", trim: true },
    shedName: { type: String, default: "", trim: true },
    year: { type: Number, index: true },
    sowingDate: { type: String, default: "" },
    /** YYYY-MM-DD for variety and overall date filters. */
    sowDay: { type: String, default: "", index: true },
    plantReadyDate: { type: String, default: "" },
    /** Day the plants leave. Set on the complete form; suggested as the covered batch date. DD-MM-YYYY. */
    out: { type: String, default: "" },
    plantsSowed: { type: Number, default: 0, min: 0 },
    orderCoveredPlants: { type: Number, default: 0, min: 0 },
    sowingBufferPct: { type: Number, default: 0, min: 0 },
    bufferPlants: { type: Number, default: 0, min: 0 },
    excessPlants: { type: Number, default: 0, min: 0 },
    mortalityMovedToExcess: { type: Number, default: 0, min: 0 },
    excessMovedToMortality: { type: Number, default: 0, min: 0 },
    noMortalityReserve: { type: Boolean, default: false },
    /** sowing = seed sow. komb = plants that came out. excess = plants still left from a sowing. */
    entryKind: {
      type: String,
      enum: ["sowing", "komb", "excess"],
      default: "sowing",
      index: true,
    },
    /** Excess entry created from this sowing. Empty on a normal sow and on komb. */
    sourceEntryId: { type: Schema.Types.ObjectId, ref: "SowingEntry", default: null },
    isIrrelevant: { type: Boolean, default: false },
    linkedOrderIds: [{ type: Schema.Types.ObjectId, ref: "Order" }],
    /** Plants this sowing took from each linked order. The sowing list reads this, not the order array. */
    orderCovers: [
      {
        orderId: { type: Schema.Types.ObjectId, ref: "Order" },
        plants: { type: Number, default: 0, min: 0 },
        partial: { type: Boolean, default: false },
      },
    ],
    /** Plants that have left on a vehicle. Unloads and returns reduce this. */
    dispatchedPlants: { type: Number, default: 0, min: 0 },
    /** Orders this sowing has dispatched plants to. Separate from the cover link. */
    dispatchedOrders: [
      {
        orderId: { type: Schema.Types.ObjectId, ref: "Order" },
        plants: { type: Number, default: 0, min: 0 },
      },
    ],
    /** Sellable plants still here. Out plants are already subtracted. Can go minus. */
    remainingPlants: { type: Number, default: 0 },
    /** Plants destroyed after sowing. Taken off sellable and remaining. */
    destroyedPlants: { type: Number, default: 0, min: 0 },
    /** Leftover plants sent to a later sowing. */
    plantsTransferredOut: { type: Number, default: 0, min: 0 },
    /** Leftover plants received from an earlier sowing. */
    plantsTransferredIn: { type: Number, default: 0, min: 0 },
    /** Leftover plants stamped as extra bookable excess on this sowing. */
    plantsMarkedSellable: { type: Number, default: 0, min: 0 },
    transferLog: [
      {
        at: { type: Date, default: Date.now },
        by: { type: Schema.Types.ObjectId, ref: "User" },
        plants: { type: Number, default: 0, min: 0 },
        direction: { type: String, enum: ["out", "in", "sellable"], required: true },
        otherEntryId: { type: Schema.Types.ObjectId, ref: "SowingEntry", default: null },
        otherRequestNumber: { type: String, default: "", trim: true },
      },
    ],
  },
  { timestamps: true, collection: "sowingentries" }
);

sowingEntrySchema.index({ plantId: 1, subtypeId: 1, sowDay: -1 });
sowingEntrySchema.index({ sowDay: -1, requestNumber: -1 });

const SowingEntry = model("SowingEntry", sowingEntrySchema);
export default SowingEntry;
