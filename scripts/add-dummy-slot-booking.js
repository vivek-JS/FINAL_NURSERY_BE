import dotenv from "dotenv";
import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";

dotenv.config();

const usage = `Usage:
  node scripts/add-dummy-slot-booking.js <slotId> <totalBookedPlants> [primarySowed]

Example:
  node scripts/add-dummy-slot-booking.js 690eeba9cd292702cf98d37d 50000 0
`;

const [slotId, totalBookedArg, primarySowedArg] = process.argv.slice(2);

if (!slotId || !totalBookedArg) {
  console.error("❌ Missing arguments.\n");
  console.log(usage);
  process.exit(1);
}

const totalBookedPlants = Number(totalBookedArg);
const primarySowed = primarySowedArg !== undefined ? Number(primarySowedArg) : 0;

if (Number.isNaN(totalBookedPlants) || Number.isNaN(primarySowed)) {
  console.error("❌ totalBookedPlants and primarySowed must be numbers.");
  process.exit(1);
}

const withObjectId = (value) => {
  try {
    return new mongoose.Types.ObjectId(value);
  } catch (error) {
    return null;
  }
};

const run = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error("MONGO_URL or MONGODB_URI environment variable is required.");
    }

    await mongoose.connect(uri);
    console.log("✅ Connected to database");

    const slotObjectId = withObjectId(slotId);
    if (!slotObjectId) {
      throw new Error("slotId must be a valid ObjectId.");
    }

    // Find the document that contains the target slot to grab plant/subtype info
    const plantSlotDoc = await PlantSlot.findOne({
      "subtypeSlots.slots._id": slotObjectId,
    }).lean();

    if (!plantSlotDoc) {
      throw new Error(`Slot ${slotId} not found.`);
    }

    let plantId = plantSlotDoc.plantId;
    let subtypeId = null;

    for (const subtype of plantSlotDoc.subtypeSlots) {
      const match = subtype.slots.find((slot) => slot._id.toString() === slotId);
      if (match) {
        subtypeId = subtype.subtypeId;
        break;
      }
    }

    if (!subtypeId) {
      throw new Error("Unable to resolve subtype for the provided slot.");
    }

    const updateResult = await PlantSlot.updateOne(
      {
        plantId,
        year: plantSlotDoc.year,
        "subtypeSlots.subtypeId": subtypeId,
        "subtypeSlots.slots._id": slotObjectId,
      },
      {
        $set: {
          "subtypeSlots.$[st].slots.$[sl].totalBookedPlants": totalBookedPlants,
          "subtypeSlots.$[st].slots.$[sl].primarySowed": primarySowed,
        },
      },
      {
        arrayFilters: [
          { "st.subtypeId": subtypeId },
          { "sl._id": slotObjectId },
        ],
      },
    );

    if (updateResult.modifiedCount === 0) {
      throw new Error("Failed to update the slot. No documents were modified.");
    }

    console.log("✅ Slot updated successfully");
    console.log(`   Slot ID       : ${slotId}`);
    console.log(`   Plant ID      : ${plantId}`);
    console.log(`   Subtype ID    : ${subtypeId}`);
    console.log(`   Total booked  : ${totalBookedPlants.toLocaleString()}`);
    console.log(`   Primary sowed : ${primarySowed.toLocaleString()}`);
  } catch (error) {
    console.error("❌ Error adding dummy slot booking:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from database");
  }
};

run();

