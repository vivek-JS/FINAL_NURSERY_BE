import mongoose from "mongoose";
import dotenv from "dotenv";
import PlantSlot from "./models/slots.model.js";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL || "mongodb://localhost:27017/nursery";

async function clearWatermelonPushkarajSowingProgress() {
  try {
    console.log("🔌 Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to MongoDB\n");

    const plantId = "691054dffba6fb380f8d57b3"; // Watermelon
    const subtypeId = "69450b7a5845df7093732cf1"; // Pushkaraj

    console.log("🔍 Finding PlantSlot documents for Watermelon Pushkaraj...");
    console.log(`   Plant ID: ${plantId}`);
    console.log(`   Subtype ID: ${subtypeId}\n`);

    const plantSlots = await PlantSlot.find({
      plantId: new mongoose.Types.ObjectId(plantId),
    });

    console.log(`📦 Found ${plantSlots.length} PlantSlot document(s)\n`);

    if (plantSlots.length === 0) {
      console.log("⚠️ No PlantSlot documents found for Watermelon");
      await mongoose.disconnect();
      return;
    }

    let totalSlotsCleared = 0;
    let totalEntriesCleared = 0;

    for (const plantSlot of plantSlots) {
      let modified = false;
      let slotsInThisDoc = 0;
      let entriesInThisDoc = 0;

      for (const subtypeSlot of plantSlot.subtypeSlots || []) {
        if (
          subtypeSlot.subtypeId &&
          subtypeSlot.subtypeId.toString() === subtypeId
        ) {
          console.log(
            `📋 Processing subtype slot for Pushkaraj in PlantSlot ${plantSlot._id}`
          );

          for (const slot of subtypeSlot.slots || []) {
            if (
              slot.sowingInProgress &&
              Array.isArray(slot.sowingInProgress) &&
              slot.sowingInProgress.length > 0
            ) {
              const entryCount = slot.sowingInProgress.length;
              console.log(
                `   🧹 Slot ${slot._id}: Clearing ${entryCount} sowingInProgress entry/entries`
              );

              // Log details of entries being cleared
              slot.sowingInProgress.forEach((entry, idx) => {
                console.log(
                  `      Entry ${idx + 1}: Request ${entry.requestNumber}, Packets: ${entry.packetsIssued || 0}`
                );
              });

              slot.sowingInProgress = [];
              modified = true;
              slotsInThisDoc++;
              entriesInThisDoc += entryCount;
              totalSlotsCleared++;
              totalEntriesCleared += entryCount;
            }
          }
        }
      }

      if (modified) {
        plantSlot.markModified("subtypeSlots");
        await plantSlot.save();
        console.log(
          `   ✅ Saved PlantSlot ${plantSlot._id} (cleared ${slotsInThisDoc} slot(s), ${entriesInThisDoc} entry/entries)\n`
        );
      }
    }

    console.log("============================================================");
    console.log("📊 SUMMARY:");
    console.log("============================================================");
    console.log(`✅ Plant: Watermelon (${plantId})`);
    console.log(`✅ Subtype: Pushkaraj (${subtypeId})`);
    console.log(`✅ Slots cleared: ${totalSlotsCleared}`);
    console.log(`✅ Total entries cleared: ${totalEntriesCleared}`);
    console.log("============================================================\n");

    await mongoose.disconnect();
    console.log("✅ Disconnected from MongoDB");
  } catch (error) {
    console.error("❌ Error:", error);
    console.error("Stack:", error.stack);
    process.exit(1);
  }
}

// Run the function
clearWatermelonPushkarajSowingProgress()
  .then(() => {
    console.log("✅ Script completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Script failed:", error);
    process.exit(1);
  });
