import mongoose from "mongoose";
import PlantSlot from "./models/slots.model.js";
import PlantCms from "./models/plantCms.model.js";
import dotenv from "dotenv";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL || "mongodb://localhost:27017/nursery";

async function clearMuskmelonAvailability() {
  try {
    console.log("🔌 Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to MongoDB\n");

    // Step 1: Find Muskmelon plant
    console.log("🌱 Finding Muskmelon plant...");
    const muskmelon = await PlantCms.findOne({ name: /muskmelon/i })
      .select("_id name sowingAllowed subtypes")
      .lean();

    if (!muskmelon) {
      console.log("❌ Muskmelon plant not found!");
      await mongoose.disconnect();
      return;
    }

    console.log(`✅ Found: ${muskmelon.name} (${muskmelon._id})`);
    console.log(`   Sowing Allowed: ${muskmelon.sowingAllowed}`);
    console.log(`   Subtypes: ${muskmelon.subtypes?.length || 0}`);
    if (muskmelon.subtypes && muskmelon.subtypes.length > 0) {
      muskmelon.subtypes.forEach((subtype, idx) => {
        console.log(`      ${idx + 1}. ${subtype.name} (${subtype._id})`);
      });
    }
    console.log("");

    // Step 2: Get all slots for Muskmelon
    console.log("📦 Finding all slots for Muskmelon...");
    const plantSlots = await PlantSlot.find({
      plantId: muskmelon._id,
    });

    console.log(`✅ Found ${plantSlots.length} PlantSlot document(s) for Muskmelon\n`);

    if (plantSlots.length === 0) {
      console.log("⚠️  No slots found for Muskmelon. Nothing to update.");
      await mongoose.disconnect();
      return;
    }

    // Step 3: Clear availability (set totalBookedPlants = totalPlants)
    console.log("🔄 Clearing availability for all Muskmelon slots...");
    console.log("   (Setting totalBookedPlants = totalPlants, so availablePlants = 0)\n");

    let totalSlotsUpdated = 0;
    let totalPlantSlotsUpdated = 0;

    for (const plantSlot of plantSlots) {
      let slotsUpdated = 0;

      // Update all slots in all subtypes
      if (plantSlot.subtypeSlots && Array.isArray(plantSlot.subtypeSlots)) {
        for (const subtypeSlot of plantSlot.subtypeSlots) {
          if (subtypeSlot.slots && Array.isArray(subtypeSlot.slots)) {
            for (const slot of subtypeSlot.slots) {
              const totalPlants = slot.totalPlants || 0;
              const currentBooked = slot.totalBookedPlants || 0;
              
              // Set totalBookedPlants = totalPlants to make availablePlants = 0
              if (totalPlants > 0 && currentBooked !== totalPlants) {
                slot.totalBookedPlants = totalPlants;
                slotsUpdated++;
                totalSlotsUpdated++;
                console.log(`   ✅ Slot ${slot._id}: Set totalBookedPlants = ${totalPlants} (was ${currentBooked})`);
              } else if (totalPlants === 0) {
                console.log(`   ⚠️  Slot ${slot._id}: totalPlants is 0, skipping`);
              } else {
                console.log(`   ℹ️  Slot ${slot._id}: Already set (totalBookedPlants = ${currentBooked}, totalPlants = ${totalPlants})`);
              }
            }
          }
        }
      }

      if (slotsUpdated > 0) {
        await plantSlot.save();
        totalPlantSlotsUpdated++;
        console.log(`\n   💾 Saved PlantSlot document (${slotsUpdated} slots updated)\n`);
      }
    }

    // Step 4: Summary
    console.log("\n📊 SUMMARY:");
    console.log("=" .repeat(60));
    console.log(`✅ Plant: ${muskmelon.name} (${muskmelon._id})`);
    console.log(`✅ PlantSlot documents processed: ${plantSlots.length}`);
    console.log(`✅ PlantSlot documents updated: ${totalPlantSlotsUpdated}`);
    console.log(`✅ Individual slots updated: ${totalSlotsUpdated}`);
    console.log("\n💡 Result:");
    console.log("   - All Muskmelon slots now have totalBookedPlants = totalPlants");
    console.log("   - This means availablePlants = 0 for all slots");
    console.log("   - No capacity available for new bookings");
    console.log("=" .repeat(60));

    console.log("\n🔌 Closing database connection...");
    await mongoose.disconnect();
    console.log("✅ Database connection closed");
    console.log("\n✨ Done!");

  } catch (error) {
    console.error("❌ Error:", error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
clearMuskmelonAvailability();





