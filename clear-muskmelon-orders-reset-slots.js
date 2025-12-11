import mongoose from "mongoose";
import dotenv from "dotenv";
import PlantCms from "./models/plantCms.model.js";
import PlantSlot from "./models/slots.model.js";
import Order from "./models/order.model.js";
import Sowing from "./models/sowing.model.js";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL || "mongodb://localhost:27017/nursery";

async function clearMuskmelonOrdersAndResetSlots() {
  try {
    console.log("🔌 Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to MongoDB\n");

    // Find Muskmelon plant
    console.log("🌱 Finding Muskmelon plant...");
    const muskmelon = await PlantCms.findOne({ name: /muskmelon/i }).lean();
    
    if (!muskmelon) {
      console.error("❌ Muskmelon plant not found!");
      await mongoose.disconnect();
      return;
    }

    console.log(`✅ Found: ${muskmelon.name} (${muskmelon._id})`);
    console.log(`   Sowing Allowed: ${muskmelon.sowingAllowed || false}`);
    console.log(`   Subtypes: ${muskmelon.subtypes?.length || 0}`);
    if (muskmelon.subtypes && muskmelon.subtypes.length > 0) {
      muskmelon.subtypes.forEach((subtype, idx) => {
        console.log(`      ${idx + 1}. ${subtype.name} (${subtype._id})`);
      });
    }
    console.log("");

    const plantId = muskmelon._id;

    // Get all slots for Muskmelon
    console.log("📦 Finding all slots for Muskmelon...");
    const plantSlots = await PlantSlot.find({ plantId: plantId }).lean();
    console.log(`✅ Found ${plantSlots.length} PlantSlot document(s) for Muskmelon\n`);

    // Collect all slot IDs
    const slotIds = [];
    plantSlots.forEach((plantSlot) => {
      if (plantSlot.subtypeSlots && plantSlot.subtypeSlots.length > 0) {
        plantSlot.subtypeSlots.forEach((subtypeSlot) => {
          if (subtypeSlot.slots && subtypeSlot.slots.length > 0) {
            subtypeSlot.slots.forEach((slot) => {
              slotIds.push(slot._id);
            });
          }
        });
      }
    });

    console.log(`📋 Total slots found: ${slotIds.length}\n`);

    // Delete all orders for Muskmelon slots
    console.log("🗑️  Deleting all orders for Muskmelon slots...");
    const deleteResult = await Order.deleteMany({
      bookingSlot: { $in: slotIds }
    });
    console.log(`✅ Deleted ${deleteResult.deletedCount} order(s)\n`);

    // Delete all sowing records for Muskmelon slots
    console.log("🗑️  Deleting all sowing records for Muskmelon slots...");
    const deleteSowingResult = await Sowing.deleteMany({
      slotId: { $in: slotIds }
    });
    console.log(`✅ Deleted ${deleteSowingResult.deletedCount} sowing record(s)\n`);

    // Reset all slots to zero (including sowed records)
    console.log("🔄 Setting totalPlants = 0, totalBookedPlants = 0, primarySowed = 0, and officeSowed = 0 for all Muskmelon slots...\n");
    
    let totalSlotsUpdated = 0;
    let totalDocumentsUpdated = 0;

    for (const plantSlot of plantSlots) {
      let slotUpdated = false;
      const updatedSubtypeSlots = plantSlot.subtypeSlots.map((subtypeSlot) => {
        if (subtypeSlot.slots && subtypeSlot.slots.length > 0) {
          const updatedSlots = subtypeSlot.slots.map((slot) => {
            let slotChanged = false;
            
            if (slot.totalPlants !== 0) {
              slot.totalPlants = 0;
              slotChanged = true;
              console.log(`   ✅ Slot ${slot._id}: Set totalPlants = 0 (was ${slot.totalPlants || 0})`);
            }
            
            if (slot.totalBookedPlants !== 0) {
              slot.totalBookedPlants = 0;
              slotChanged = true;
              console.log(`   ✅ Slot ${slot._id}: Set totalBookedPlants = 0 (was ${slot.totalBookedPlants || 0})`);
            }
            
            if (slot.primarySowed !== 0) {
              slot.primarySowed = 0;
              slotChanged = true;
              console.log(`   ✅ Slot ${slot._id}: Set primarySowed = 0 (was ${slot.primarySowed || 0})`);
            }
            
            if (slot.officeSowed !== 0) {
              slot.officeSowed = 0;
              slotChanged = true;
              console.log(`   ✅ Slot ${slot._id}: Set officeSowed = 0 (was ${slot.officeSowed || 0})`);
            }
            
            if (slotChanged) {
              slotUpdated = true;
              totalSlotsUpdated++;
            }
            
            return slot;
          });

          return {
            ...subtypeSlot,
            slots: updatedSlots,
          };
        }
        return subtypeSlot;
      });

      if (slotUpdated) {
        await PlantSlot.updateOne(
          { _id: plantSlot._id },
          { $set: { subtypeSlots: updatedSubtypeSlots } }
        );
        totalDocumentsUpdated++;
        console.log(`   💾 Saved PlantSlot document (slots updated)\n`);
      }
    }

    console.log("");
    console.log("📊 SUMMARY:");
    console.log("============================================================");
    console.log(`✅ Plant: ${muskmelon.name} (${plantId})`);
    console.log(`✅ Orders deleted: ${deleteResult.deletedCount}`);
    console.log(`✅ Sowing records deleted: ${deleteSowingResult.deletedCount}`);
    console.log(`✅ PlantSlot documents processed: ${plantSlots.length}`);
    console.log(`✅ PlantSlot documents updated: ${totalDocumentsUpdated}`);
    console.log(`✅ Individual slots updated: ${totalSlotsUpdated}`);
    console.log("");
    console.log("💡 Result:");
    console.log("   - All Muskmelon orders have been deleted");
    console.log("   - All Muskmelon sowing records have been deleted");
    console.log("   - All Muskmelon slots now have totalPlants = 0");
    console.log("   - All Muskmelon slots now have totalBookedPlants = 0");
    console.log("   - All Muskmelon slots now have primarySowed = 0");
    console.log("   - All Muskmelon slots now have officeSowed = 0");
    console.log("   - This means availablePlants = 0 for all slots");
    console.log("============================================================");
    console.log("");

    console.log("🔌 Closing database connection...");
    await mongoose.disconnect();
    console.log("✅ Database connection closed");

    console.log("\n✨ Done!");
  } catch (error) {
    console.error("❌ Error:", error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

clearMuskmelonOrdersAndResetSlots();

