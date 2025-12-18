import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";

const checkTwinklePlantReadyDays = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error("MONGO_URL or MONGODB_URI environment variable is required.");
    }
    await mongoose.connect(uri);
    console.log("✅ Connected to MongoDB\n");

    // Find Watermelon plant
    const watermelon = await PlantCms.findOne({ 
      name: { $regex: /^watermelon$/i } 
    }).lean();

    if (!watermelon) {
      console.log("❌ Watermelon plant not found.");
      return;
    }

    console.log(`📊 Found Watermelon plant: ${watermelon.name} (ID: ${watermelon._id})\n`);

    // Find Twinkle subtype
    const twinkleSubtype = watermelon.subtypes?.find(
      (st) => st.name && st.name.toLowerCase().includes("twinkle")
    );

    if (!twinkleSubtype) {
      console.log("❌ Twinkle subtype not found in Watermelon.");
      console.log("\nAvailable subtypes:");
      watermelon.subtypes?.forEach((st, idx) => {
        console.log(`   ${idx + 1}. ${st.name} (plantReadyDays: ${st.plantReadyDays || 0})`);
      });
      return;
    }

    console.log(`🌱 Twinkle Subtype Details:`);
    console.log(`   - Name: ${twinkleSubtype.name}`);
    console.log(`   - Subtype ID: ${twinkleSubtype._id}`);
    console.log(`   - Plant Ready Days (from PlantCMS): ${twinkleSubtype.plantReadyDays || 0}`);

    // Check slot-level plantReadyDays
    const slots = await PlantSlot.find({ plantId: watermelon._id }).lean();
    let slotLevelReadyDays = null;
    let slotCount = 0;

    for (const plantSlot of slots) {
      for (const subtypeSlot of plantSlot.subtypeSlots || []) {
        if (subtypeSlot.subtypeId?.toString() === twinkleSubtype._id.toString()) {
          for (const slot of subtypeSlot.slots || []) {
            slotCount++;
            if (slot.plantReadyDays && slot.plantReadyDays > 0) {
              if (slotLevelReadyDays === null) {
                slotLevelReadyDays = slot.plantReadyDays;
              } else if (slotLevelReadyDays !== slot.plantReadyDays) {
                console.log(`   ⚠️  Warning: Different slot-level plantReadyDays found: ${slot.plantReadyDays}`);
              }
            }
          }
        }
      }
    }

    if (slotLevelReadyDays !== null) {
      console.log(`   - Plant Ready Days (from Slot level): ${slotLevelReadyDays}`);
      console.log(`   - Priority: Slot-level value (${slotLevelReadyDays}) takes precedence over PlantCMS value (${twinkleSubtype.plantReadyDays || 0})`);
    } else {
      console.log(`   - Plant Ready Days (from Slot level): Not set (will use PlantCMS value: ${twinkleSubtype.plantReadyDays || 0})`);
    }

    console.log(`   - Total slots checked: ${slotCount}`);

    // Final answer
    const finalPlantReadyDays = slotLevelReadyDays || twinkleSubtype.plantReadyDays || 0;
    console.log(`\n✅ Final Plant Ready Days for Twinkle: ${finalPlantReadyDays} days`);

    await mongoose.disconnect();
    console.log("\n✅ Disconnected from MongoDB");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
};

checkTwinklePlantReadyDays();

