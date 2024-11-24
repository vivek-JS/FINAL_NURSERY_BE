import { Schema, model } from "mongoose";
import PlantSlot from "./slots.model.js";
import { generateSlotsForYear } from "../controllers/slots.controller.js";

const plantSubtypeSchema = new Schema({
  name: { type: String, required: true },
  description: { type: String },
  characteristics: { type: Map, of: String },
});

const plantSchema = new Schema({
  name: { type: String, required: true },
  subtypes: [plantSubtypeSchema], // Array of embedded subtypes
  addedBy: { type: Schema.Types.ObjectId, ref: "User" },
  createdAt: { type: Date, default: Date.now },
  slotSize: { type: Number, default: 5, required: true }, // Slot size in days
});

// Middleware to create/update slots after plant save
plantSchema.post("save", async function (doc) {
  try {
    const year = new Date().getFullYear(); // Current year
    const { slotSize = 5 } = doc; // Default to 5 if slotSize is not provided

    // Fetch existing slots for this plant and year
    const existingPlantSlot = await PlantSlot.findOne({
      plantId: doc._id,
      year,
    });

    const existingSubtypeIds = new Set(
      existingPlantSlot?.subtypeSlots.map((slot) => slot.subtypeId.toString()) || []
    );

    // Identify new subtypes that need slot creation
    const newSubtypes = doc.subtypes.filter(
      (subtype) => !existingSubtypeIds.has(subtype._id.toString())
    );

    // Update or create slots for new subtypes
    if (newSubtypes.length > 0) {
      const newSubtypeSlots = newSubtypes.map((subtype) => ({
        subtypeId: subtype._id,
        slots: generateSlotsForYear(year, slotSize), // Use updated slot size
      }));

      if (existingPlantSlot) {
        existingPlantSlot.subtypeSlots.push(...newSubtypeSlots);
        await existingPlantSlot.save();
      } else {
        const newPlantSlot = new PlantSlot({
          plantId: doc._id,
          year,
          subtypeSlots: newSubtypeSlots,
        });
        await newPlantSlot.save();
      }
    }

    // Optionally, regenerate slots for existing subtypes if slot size changes
    if (existingPlantSlot && existingPlantSlot.slotSize !== slotSize) {
      existingPlantSlot.subtypeSlots.forEach((subtypeSlot) => {
        subtypeSlot.slots = generateSlotsForYear(year, slotSize);
      });
      existingPlantSlot.slotSize = slotSize;
      await existingPlantSlot.save();
    }
  } catch (error) {
    console.error("Error updating slots after plant save:", error);
  }
});

// Middleware to delete slots after plant removal
plantSchema.post("remove", async function (doc) {
  try {
    await PlantSlot.deleteMany({ plantId: doc._id });
    console.log(`Slots for plant ${doc._id} have been deleted.`);
  } catch (error) {
    console.error(`Error deleting slots for plant ${doc._id}:`, error);
  }
});

const PlantCms = model("PlantCms", plantSchema);
export default PlantCms;
