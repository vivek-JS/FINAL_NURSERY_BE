import { Schema, model } from "mongoose";
import PlantSlot from "./slots.model.js";

const plantSubtypeSchema = new Schema({
  name: { type: String, required: true },
  description: { type: String },
  characteristics: { type: Map, of: String },
  rates: { type: [Number], default: [] }, // Per-subtype list prices in DB; callers often use rates[0] as the active rate
  dailyDispatch: { type: Number, default: 0 }, // Daily dispatch capacity for this subtype
  buffer: { type: Number, default: 0 }, // Buffer at plant subtype level
  plantReadyDays: { type: Number, default: 0 }, // Number of days for plant to be ready from sowing
  slotDays: { type: Number, required: true }, // Number of days per slot for this subtype
  slotStartDate: { type: String, required: true }, // Start date for slot generation (YYYY-MM-DD or DD-MM-YYYY format)
  slotEndDate: { type: String, required: true }, // End date for slot generation (YYYY-MM-DD or DD-MM-YYYY format)
  slotCapacity: { type: Number, required: true }, // Total plants per slot for this subtype
});

const plantSchema = new Schema({
  name: { type: String, required: true },
  subtypes: [plantSubtypeSchema], // Array of embedded subtypes
  addedBy: { type: Schema.Types.ObjectId, ref: "User" },
  createdAt: { type: Date, default: Date.now },
  slotSize: { type: Number, default: 5, required: true }, // Slot size in days
  buffer: { type: Number, default: 0 }, // Buffer at plant level
  sowingAllowed: { type: Boolean, default: false }, // Whether sowing is allowed for this plant
  dailyDispatchCapacity: { type: Number, default: 2000 }, // Daily dispatch capacity for this plant
  sowingBuffer: { type: Number, default: 0 }, // Sowing buffer percentage for this plant
});

// Auto slot generation removed - slots are now managed through dedicated slot management system

// Middleware to delete slots after plant removal
plantSchema.post("remove", async function (doc) {
  try {
    await PlantSlot.deleteMany({ plantId: doc._id });
    // console.log(`Slots for plant ${doc._id} have been deleted.`);
  } catch (error) {
    // console.error(`Error deleting slots for plant ${doc._id}:`, error);
  }
});

const PlantCms = model("PlantCms", plantSchema);
export default PlantCms;
