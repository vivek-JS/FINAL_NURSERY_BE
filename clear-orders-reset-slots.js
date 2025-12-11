import mongoose from "mongoose";
import Order from "./models/order.model.js";
import PlantSlot from "./models/slots.model.js";
import PlantCms from "./models/plantCms.model.js";
import dotenv from "dotenv";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/nursery";

async function clearOrdersAndResetSlots() {
  try {
    console.log("🔌 Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to MongoDB\n");

    // Step 1: Get all sowing-allowed plants
    console.log("🌱 Finding sowing-allowed plants...");
    const sowingAllowedPlants = await PlantCms.find({ sowingAllowed: true })
      .select("_id name")
      .lean();

    console.log(`✅ Found ${sowingAllowedPlants.length} sowing-allowed plants:`);
    sowingAllowedPlants.forEach((plant) => {
      console.log(`   - ${plant.name} (${plant._id})`);
    });
    console.log("");

    const plantIds = sowingAllowedPlants.map((p) => p._id);

    // Step 2: Count orders before deletion
    console.log("📊 Counting orders before deletion...");
    const orderCount = await Order.countDocuments();
    const dealerOrderCount = await (await import("./models/dealerOrder.model.js")).default.countDocuments();
    console.log(`   📦 Regular Orders: ${orderCount} documents`);
    console.log(`   📦 Dealer Orders: ${dealerOrderCount} documents`);
    console.log(`   📦 Total Orders: ${orderCount + dealerOrderCount} documents\n`);

    // Step 3: Delete ALL orders
    console.log("🗑️  Deleting all orders...");
    const deleteResult = await Order.deleteMany({});
    const DealerOrder = (await import("./models/dealerOrder.model.js")).default;
    const dealerDeleteResult = await DealerOrder.deleteMany({});
    console.log(`   ✅ Regular Orders: Deleted ${deleteResult.deletedCount} documents`);
    console.log(`   ✅ Dealer Orders: Deleted ${dealerDeleteResult.deletedCount} documents`);
    console.log(`   ✅ Total Deleted: ${deleteResult.deletedCount + dealerDeleteResult.deletedCount} orders\n`);

    if (plantIds.length === 0) {
      console.log("⚠️  No sowing-allowed plants found.");
      console.log("✅ All orders have been deleted.");
      console.log("   (No slots to reset since there are no sowing-allowed plants)\n");
      await mongoose.disconnect();
      return;
    }

    // Step 4: Reset slots for sowing-allowed plants
    console.log("🔄 Resetting slots for sowing-allowed plants...");
    console.log("   (Setting totalBookedPlants = 0 for all slots)\n");

    let totalSlotsReset = 0;
    let totalSubtypeSlotsReset = 0;

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
              if (slot.totalBookedPlants !== undefined && slot.totalBookedPlants !== 0) {
                slot.totalBookedPlants = 0;
                slotsUpdated++;
                totalSlotsReset++;
              }
            }
            totalSubtypeSlotsReset++;
          }
        }
      }

      if (slotsUpdated > 0) {
        await plantSlot.save();
        console.log(`   ✅ Reset ${slotsUpdated} slots in plant ${plantSlot.plantId}`);
      }
    }

    console.log("\n📊 SUMMARY:");
    console.log("=" .repeat(50));
    console.log(`✅ Orders deleted: ${deleteResult.deletedCount}`);
    console.log(`✅ PlantSlot documents processed: ${plantSlots.length}`);
    console.log(`✅ Subtype slots processed: ${totalSubtypeSlotsReset}`);
    console.log(`✅ Individual slots reset (totalBookedPlants = 0): ${totalSlotsReset}`);
    console.log("\n💡 Result:");
    console.log("   - All orders have been deleted");
    console.log("   - All slots for sowing-allowed plants now have totalBookedPlants = 0");
    console.log("   - This means availablePlants = totalPlants for all slots");
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
clearOrdersAndResetSlots();

