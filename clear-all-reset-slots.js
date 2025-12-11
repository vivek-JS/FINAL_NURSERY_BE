import mongoose from "mongoose";
import Order from "./models/order.model.js";
import PlantSlot from "./models/slots.model.js";
import PlantCms from "./models/plantCms.model.js";
import dotenv from "dotenv";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL || "mongodb://localhost:27017/nursery";

async function clearAllAndResetSlots() {
  try {
    console.log("🔌 Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to MongoDB\n");

    // Step 1: Show all plants
    console.log("🌱 Checking all plants...");
    const allPlants = await PlantCms.find().select("_id name sowingAllowed").lean();
    console.log(`\n📋 Total Plants: ${allPlants.length}`);
    if (allPlants.length > 0) {
      console.log("\nPlant List:");
      allPlants.forEach((plant) => {
        console.log(`   ${plant.sowingAllowed ? "✅" : "❌"} ${plant.name} (${plant._id}) - Sowing Allowed: ${plant.sowingAllowed}`);
      });
    }

    // Step 2: Get sowing-allowed plants
    console.log("\n🌱 Finding sowing-allowed plants...");
    const sowingAllowedPlants = await PlantCms.find({ sowingAllowed: true })
      .select("_id name")
      .lean();

    console.log(`✅ Found ${sowingAllowedPlants.length} sowing-allowed plants`);
    if (sowingAllowedPlants.length > 0) {
      sowingAllowedPlants.forEach((plant) => {
        console.log(`   - ${plant.name} (${plant._id})`);
      });
    }
    console.log("");

    const plantIds = sowingAllowedPlants.map((p) => p._id);

    // Step 3: Count and delete orders
    console.log("📊 Counting orders before deletion...");
    const OrderModel = Order;
    const DealerOrder = (await import("./models/dealerOrder.model.js")).default;
    
    const orderCount = await OrderModel.countDocuments();
    const dealerOrderCount = await DealerOrder.countDocuments();
    console.log(`   📦 Regular Orders: ${orderCount} documents`);
    console.log(`   📦 Dealer Orders: ${dealerOrderCount} documents`);
    console.log(`   📦 Total Orders: ${orderCount + dealerOrderCount} documents\n`);

    if (orderCount > 0 || dealerOrderCount > 0) {
      console.log("🗑️  Deleting all orders...");
      const deleteResult = await OrderModel.deleteMany({});
      const dealerDeleteResult = await DealerOrder.deleteMany({});
      console.log(`   ✅ Regular Orders: Deleted ${deleteResult.deletedCount} documents`);
      console.log(`   ✅ Dealer Orders: Deleted ${dealerDeleteResult.deletedCount} documents`);
      console.log(`   ✅ Total Deleted: ${deleteResult.deletedCount + dealerDeleteResult.deletedCount} orders\n`);
    } else {
      console.log("✅ No orders to delete (already empty)\n");
    }

    // Step 4: Reset slots for sowing-allowed plants
    let totalSlotsReset = 0;
    let totalPlantSlotsReset = 0;

    if (plantIds.length === 0) {
      console.log("⚠️  No sowing-allowed plants found.");
      console.log("   Cannot reset slots (no sowing-allowed plants exist).\n");
      console.log("💡 To enable sowing for a plant, set 'sowingAllowed: true' in PlantCms collection.\n");
    } else {
      console.log("🔄 Resetting slots for sowing-allowed plants...");
      console.log("   (Setting totalBookedPlants = 0, so availablePlants = totalPlants)\n");

      // Get all plant slots for sowing-allowed plants
      const plantSlots = await PlantSlot.find({
        plantId: { $in: plantIds },
      });

      console.log(`   Found ${plantSlots.length} PlantSlot documents for sowing-allowed plants\n`);

      for (const plantSlot of plantSlots) {
        let slotsUpdated = 0;

        // Reset totalBookedPlants for all slots in all subtypes
        if (plantSlot.subtypeSlots && Array.isArray(plantSlot.subtypeSlots)) {
          for (const subtypeSlot of plantSlot.subtypeSlots) {
            if (subtypeSlot.slots && Array.isArray(subtypeSlot.slots)) {
              for (const slot of subtypeSlot.slots) {
                // Reset totalBookedPlants to 0
                if (slot.totalBookedPlants !== undefined && slot.totalBookedPlants !== 0) {
                  slot.totalBookedPlants = 0;
                  slotsUpdated++;
                  totalSlotsReset++;
                }
              }
            }
          }
        }

        if (slotsUpdated > 0) {
          await plantSlot.save();
          totalPlantSlotsReset++;
          console.log(`   ✅ Reset ${slotsUpdated} slots in plant ${plantSlot.plantId}`);
        }
      }

      console.log("\n📊 SLOT RESET SUMMARY:");
      console.log("=" .repeat(50));
      console.log(`✅ PlantSlot documents processed: ${plantSlots.length}`);
      console.log(`✅ PlantSlot documents with changes: ${totalPlantSlotsReset}`);
      console.log(`✅ Individual slots reset (totalBookedPlants = 0): ${totalSlotsReset}`);
    }

    console.log("\n📊 FINAL SUMMARY:");
    console.log("=" .repeat(50));
    console.log(`✅ Orders deleted: ${orderCount + dealerOrderCount} (regular: ${orderCount}, dealer: ${dealerOrderCount})`);
    if (plantIds.length > 0) {
      console.log(`✅ Sowing-allowed plants found: ${plantIds.length}`);
      console.log(`✅ Slots reset: ${totalSlotsReset || 0} slots across ${totalPlantSlotsReset || 0} PlantSlot documents`);
    } else {
      console.log(`⚠️  Sowing-allowed plants: 0 (no slots to reset)`);
    }
    console.log("\n💡 Result:");
    console.log("   - All orders have been deleted");
    if (plantIds.length > 0) {
      console.log("   - All slots for sowing-allowed plants now have totalBookedPlants = 0");
      console.log("   - This means availablePlants = totalPlants for all slots (full capacity available)");
    }
    console.log("=" .repeat(50));

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
clearAllAndResetSlots();

