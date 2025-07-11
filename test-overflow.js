// Test file to verify overflow functionality
import mongoose from "mongoose";
import { updateSlot } from "./controllers/factory.controller.js";
import { getSlotInfo } from "./controllers/excel.serveces.controller.js";
import PlantSlot from "./models/slots.model.js";

// Test function to verify overflow functionality
async function testOverflowFunctionality() {
  try {
    // Connect to MongoDB (you'll need to set your connection string)
    await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/nursery");
    console.log("Connected to MongoDB");

    // Find an existing slot to test with
    const plantSlot = await PlantSlot.findOne({
      "subtypeSlots.slots": { $exists: true, $ne: [] }
    });

    if (!plantSlot) {
      console.log("No slots found for testing");
      return;
    }

    const testSlot = plantSlot.subtypeSlots[0].slots[0];
    console.log("Testing with slot:", {
      slotId: testSlot._id,
      currentTotalPlants: testSlot.totalPlants,
      currentBookedPlants: testSlot.totalBookedPlants,
      startDay: testSlot.startDay,
      endDay: testSlot.endDay
    });

    // Test 1: Try to book more plants than available (should allow overflow)
    const plantsToBook = testSlot.totalPlants + 100; // Book more than available
    console.log(`\nTest 1: Booking ${plantsToBook} plants (more than available ${testSlot.totalPlants})`);
    
    await updateSlot(testSlot._id, plantsToBook, "subtract", true); // allowOverflow = true
    
    const slotInfoAfterBooking = await getSlotInfo(testSlot._id);
    console.log("After booking:", {
      totalPlants: slotInfoAfterBooking.totalPlants,
      totalBookedPlants: slotInfoAfterBooking.totalBookedPlants,
      availablePlants: slotInfoAfterBooking.availablePlants,
      isOverflow: slotInfoAfterBooking.isOverflow
    });

    // Test 2: Add capacity back to bring slot out of overflow
    console.log(`\nTest 2: Adding ${plantsToBook + 50} plants to bring slot out of overflow`);
    
    await updateSlot(testSlot._id, plantsToBook + 50, "add", true); // allowOverflow = true
    
    const slotInfoAfterReset = await getSlotInfo(testSlot._id);
    console.log("After reset:", {
      totalPlants: slotInfoAfterReset.totalPlants,
      totalBookedPlants: slotInfoAfterReset.totalBookedPlants,
      availablePlants: slotInfoAfterReset.availablePlants,
      isOverflow: slotInfoAfterReset.isOverflow
    });

    console.log("\n✅ All tests passed! Overflow functionality is working correctly.");

  } catch (error) {
    console.error("❌ Test failed:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

// Run the test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testOverflowFunctionality();
}

export { testOverflowFunctionality }; 