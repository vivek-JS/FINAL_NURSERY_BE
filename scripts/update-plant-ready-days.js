import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";

const PLANT_CONFIGS = [
  {
    name: "Papaya",
    getReadyDays: (month) => {
      const monthName = (month || "").toLowerCase();
      if (["november", "december", "january"].includes(monthName)) return 60;
      if (["february", "march", "april", "may"].includes(monthName)) return 40;
      if (["june", "july", "august", "september", "october"].includes(monthName)) return 35;
      return null;
    },
  },
  {
    name: "Watermelon",
    getReadyDays: () => 20,
  },
];

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error("MONGO_URL or MONGODB_URI environment variable is required.");
    }
    await mongoose.connect(uri);
    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("❌ Failed to connect to MongoDB:", error.message);
    process.exit(1);
  }
};

const applyPlantReadyDays = async () => {
  for (const config of PLANT_CONFIGS) {
    console.log(`\n🌱 Updating plant ready days for "${config.name}"`);

    const plant = await PlantCms.findOne({
      name: { $regex: `^${config.name}$`, $options: "i" },
    });

    if (!plant) {
      console.warn(`⚠️  Plant "${config.name}" not found. Skipping.`);
      continue;
    }

    const plantSlots = await PlantSlot.find({ plantId: plant._id });
    if (!plantSlots.length) {
      console.warn(`⚠️  No slot documents found for "${plant.name}".`);
      continue;
    }

    let updatedSlotCount = 0;
    let touchedYears = new Set();

    for (const slotDoc of plantSlots) {
      let documentModified = false;

      for (const subtypeSlot of slotDoc.subtypeSlots || []) {
        for (const slot of subtypeSlot.slots || []) {
          const desiredDays = config.getReadyDays(slot.month);

          if (desiredDays === null) continue;

          if (slot.plantReadyDays !== desiredDays) {
            slot.plantReadyDays = desiredDays;
            documentModified = true;
            updatedSlotCount += 1;
          }
        }
      }

      if (documentModified) {
        await slotDoc.save();
        touchedYears.add(slotDoc.year);
      }
    }

    console.log(
      `   ✅ ${updatedSlotCount} slot(s) updated across ${touchedYears.size} year(s) for "${plant.name}".`
    );
  }
};

const run = async () => {
  try {
    await connectDB();
    await applyPlantReadyDays();
    console.log("\n🎉 Plant ready days update complete.\n");
  } catch (error) {
    console.error("❌ Error while updating plant ready days:", error);
  } finally {
    await mongoose.connection.close();
    console.log("🔌 MongoDB connection closed.");
  }
};

run();

