import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
import Sowing from "../models/sowing.model.js";
import moment from "moment";

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log("✅ Connected to database");
  } catch (error) {
    console.error("❌ Database connection error:", error);
    process.exit(1);
  }
};

const addTestSowingData = async () => {
  try {
    console.log("\n🌱 Adding Test Sowing Data...\n");

    // Get all plants with sowing allowed
    const sowingPlants = await PlantCms.find({ sowingAllowed: true });

    if (sowingPlants.length === 0) {
      console.log("⚠️  No plants with sowing allowed found.");
      console.log("Please enable sowing for some plants first.");
      return;
    }

    console.log(`Found ${sowingPlants.length} plant(s) with sowing allowed:\n`);

    const testQuantity = 200000; // 2 lakh
    const createdSowings = [];

    for (const plant of sowingPlants) {
      console.log(`\n📌 Plant: ${plant.name}`);
      console.log(`   Subtypes: ${plant.subtypes.length}`);

      for (const subtype of plant.subtypes) {
        if (!subtype.plantReadyDays || subtype.plantReadyDays === 0) {
          console.log(`   ⚠️  Skipping ${subtype.name} - No plant ready days set`);
          continue;
        }

        // Check if sowing record already exists
        const existingSowing = await Sowing.findOne({
          plantId: plant._id,
          subtypeId: subtype._id,
          totalQuantityRequired: testQuantity,
        });

        if (existingSowing) {
          console.log(`   ℹ️  ${subtype.name} - Record already exists, skipping`);
          continue;
        }

        // Create sowing records for different dates
        const sowingDates = [
          moment().add(5, "days"), // 5 days from now
          moment().add(10, "days"), // 10 days from now
          moment().add(15, "days"), // 15 days from now
        ];

        for (const sowingDate of sowingDates) {
          const expectedReadyDate = sowingDate
            .clone()
            .add(subtype.plantReadyDays, "days");

          const sowing = new Sowing({
            plantId: plant._id,
            plantName: plant.name,
            subtypeId: subtype._id,
            subtypeName: subtype.name,
            sowingDate: sowingDate.format("DD-MM-YYYY"),
            plantReadyDays: subtype.plantReadyDays,
            expectedReadyDate: expectedReadyDate.format("DD-MM-YYYY"),
            totalQuantityRequired: testQuantity,
            officeSowed: 0,
            primarySowed: 0,
            totalSowed: 0,
            remainingToSow: testQuantity,
            status: "PENDING",
            reminderBeforeDays: 5,
            notes: `Test data - ${testQuantity.toLocaleString()} booking simulation`,
          });

          await sowing.save();
          createdSowings.push(sowing);

          console.log(
            `   ✅ Created: ${subtype.name} - ${testQuantity.toLocaleString()} plants - Sowing: ${sowingDate.format(
              "DD-MM-YYYY"
            )}`
          );
        }
      }
    }

    console.log(`\n\n✨ Summary:`);
    console.log(`   Total sowing records created: ${createdSowings.length}`);
    console.log(`   Total plants covered: ${sowingPlants.length}`);
    console.log(`   Quantity per record: ${testQuantity.toLocaleString()}`);
    console.log(`\n🎉 Test data added successfully!`);
  } catch (error) {
    console.error("\n❌ Error adding test data:", error);
  }
};

const clearTestData = async () => {
  try {
    console.log("\n🗑️  Clearing Test Sowing Data...\n");

    const result = await Sowing.deleteMany({
      notes: { $regex: "Test data", $options: "i" },
    });

    console.log(`✅ Deleted ${result.deletedCount} test sowing records`);
  } catch (error) {
    console.error("❌ Error clearing test data:", error);
  }
};

const main = async () => {
  await connectDB();

  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "clear") {
    await clearTestData();
  } else if (command === "add") {
    await addTestSowingData();
  } else {
    console.log("\n🌱 Sowing Test Data Manager\n");
    console.log("Usage:");
    console.log("  node scripts/add-sowing-test-data.js add     - Add test data");
    console.log("  node scripts/add-sowing-test-data.js clear   - Clear test data");
    console.log("\nAdding test data by default...\n");
    await addTestSowingData();
  }

  await mongoose.disconnect();
  console.log("\n✅ Disconnected from database");
  process.exit(0);
};

main();


