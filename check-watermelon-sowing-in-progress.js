import mongoose from "mongoose";
import dotenv from "dotenv";
import PlantSlot from "./models/slots.model.js";
import PlantCms from "./models/plantCms.model.js";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL || "mongodb://localhost:27017/nursery";

async function checkWatermelonSowingInProgress() {
  try {
    console.log("🔌 Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to MongoDB\n");

    const plantId = "691054dffba6fb380f8d57b3"; // Watermelon

    // Get plant info
    const plant = await PlantCms.findById(plantId);
    const plantName = plant?.name || "Watermelon";
    console.log(`🌱 Checking slots for: ${plantName} (${plantId})\n`);

    // Find all PlantSlot documents for watermelon
    const plantSlots = await PlantSlot.find({
      plantId: new mongoose.Types.ObjectId(plantId),
    });

    console.log(`📦 Found ${plantSlots.length} PlantSlot document(s)\n`);

    if (plantSlots.length === 0) {
      console.log("⚠️ No PlantSlot documents found for Watermelon");
      await mongoose.disconnect();
      return;
    }

    let totalSlotsWithProgress = 0;
    let totalProgressEntries = 0;
    const slotsDetails = [];

    // Process each PlantSlot document
    for (const plantSlot of plantSlots) {
      for (const subtypeSlot of plantSlot.subtypeSlots || []) {
        const subtypeId = subtypeSlot.subtypeId?.toString();
        
        // Get subtype name
        let subtypeName = "Unknown";
        if (plant?.subtypes) {
          const subtype = plant.subtypes.find(
            (st) => st._id?.toString() === subtypeId
          );
          subtypeName = subtype?.name || subtypeId || "Unknown";
        }

        for (const slot of subtypeSlot.slots || []) {
          if (
            slot.sowingInProgress &&
            Array.isArray(slot.sowingInProgress) &&
            slot.sowingInProgress.length > 0
          ) {
            totalSlotsWithProgress++;
            const entryCount = slot.sowingInProgress.length;
            totalProgressEntries += entryCount;

            // Collect details
            const slotDetails = {
              slotId: slot._id.toString(),
              subtypeName,
              subtypeId,
              entryCount,
              entries: slot.sowingInProgress.map((entry) => ({
                requestNumber: entry.requestNumber,
                packetsIssued: entry.packetsIssued || 0,
                plantsExpected: entry.plantsExpected || 0,
                issuedDate: entry.issuedDate,
                sowingRequestId: entry.sowingRequestId?.toString(),
                outwardId: entry.outwardId?.toString(),
              })),
              slotStartDay: slot.startDay,
              slotEndDay: slot.endDay,
              month: slot.month,
            };

            slotsDetails.push(slotDetails);
          }
        }
      }
    }

    // Display results
    console.log("=".repeat(80));
    console.log("📊 WATERMELON SLOTS WITH SOWING IN PROGRESS");
    console.log("=".repeat(80));
    console.log(`✅ Total slots with sowingInProgress: ${totalSlotsWithProgress}`);
    console.log(`✅ Total progress entries: ${totalProgressEntries}`);
    console.log("=".repeat(80));
    console.log("");

    if (slotsDetails.length > 0) {
      // Group by subtype
      const bySubtype = {};
      slotsDetails.forEach((detail) => {
        const key = detail.subtypeName;
        if (!bySubtype[key]) {
          bySubtype[key] = [];
        }
        bySubtype[key].push(detail);
      });

      // Display grouped by subtype
      for (const [subtypeName, slots] of Object.entries(bySubtype)) {
        console.log(`\n📋 Subtype: ${subtypeName} (${slots.length} slot(s))`);
        console.log("-".repeat(80));

        slots.forEach((detail, idx) => {
          console.log(`\n  Slot ${idx + 1}:`);
          console.log(`    Slot ID: ${detail.slotId}`);
          console.log(`    Date Range: ${detail.slotStartDay} - ${detail.slotEndDay} (${detail.month})`);
          console.log(`    Progress Entries: ${detail.entryCount}`);

          detail.entries.forEach((entry, entryIdx) => {
            console.log(`      Entry ${entryIdx + 1}:`);
            console.log(`        Request: ${entry.requestNumber}`);
            console.log(`        Packets Issued: ${entry.packetsIssued}`);
            console.log(`        Plants Expected: ${entry.plantsExpected}`);
            console.log(`        Issued Date: ${entry.issuedDate || "N/A"}`);
            console.log(`        Sowing Request ID: ${entry.sowingRequestId || "N/A"}`);
            console.log(`        Outward ID: ${entry.outwardId || "N/A"}`);
          });
        });
      }
    } else {
      console.log("ℹ️  No slots found with sowingInProgress entries");
    }

    console.log("\n" + "=".repeat(80));
    console.log("📊 SUMMARY:");
    console.log("=".repeat(80));
    console.log(`✅ Plant: ${plantName} (${plantId})`);
    console.log(`✅ Total slots with sowingInProgress: ${totalSlotsWithProgress}`);
    console.log(`✅ Total progress entries: ${totalProgressEntries}`);
    console.log("=".repeat(80));

    await mongoose.disconnect();
    console.log("\n✅ Disconnected from MongoDB");
  } catch (error) {
    console.error("❌ Error:", error);
    console.error("Stack:", error.stack);
    process.exit(1);
  }
}

// Run the function
checkWatermelonSowingInProgress()
  .then(() => {
    console.log("\n✅ Script completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Script failed:", error);
    process.exit(1);
  });

