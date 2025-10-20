import { Schema, model } from "mongoose";
import PlantSlot from "./slots.model.js";

const plantSubtypeSchema = new Schema({
  name: { type: String, required: true },
  description: { type: String },
  characteristics: { type: Map, of: String },
  rates: { type: [Number], default: [] }, // Array of rates for each subtype
  dailyDispatch: { type: Number, default: 0 }, // Daily dispatch capacity for this subtype
  buffer: { type: Number, default: 0 }, // Buffer at plant subtype level
  plantReadyDays: { type: Number, default: 0 }, // Number of days for plant to be ready from sowing
});

const plantSchema = new Schema({
  name: { type: String, required: true },
  subtypes: [plantSubtypeSchema], // Array of embedded subtypes
  addedBy: { type: Schema.Types.ObjectId, ref: "User" },
  createdAt: { type: Date, default: Date.now },
  slotSize: { type: Number, default: 5, required: true }, // Slot size in days
  buffer: { type: Number, default: 0 }, // Buffer at plant level
  sowingAllowed: { type: Boolean, default: false }, // Whether sowing is allowed for this plant
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
