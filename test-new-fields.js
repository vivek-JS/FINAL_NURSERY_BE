import mongoose from "mongoose";
import Farmer from "./models/farmer.model.js";
import Order from "./models/order.model.js";

// Test script to demonstrate the new fields functionality
async function testNewFields() {
  try {
    // Connect to MongoDB (adjust connection string as needed)
    await mongoose.connect("mongodb://localhost:27017/your-database-name");
    console.log("Connected to MongoDB");

    // Test 1: Create a farmer with referral
    console.log("\n=== Test 1: Creating farmers with referral ===");
    
    // Create referring farmer
    const referringFarmer = await Farmer.create({
      name: "John Doe",
      mobileNumber: 9876543210,
      village: "Test Village",
      taluka: "Test Taluka", 
      district: "Test District",
      state: "Maharashtra",
      talukaName: "Test Taluka",
      districtName: "Test District",
      stateName: "Maharashtra"
    });
    
    console.log("Created referring farmer:", referringFarmer._id);

    // Test 2: Create an order with "order for" field
    console.log("\n=== Test 2: Creating order with 'order for' field ===");
    
    const orderWithOrderFor = await Order.create({
      orderId: 9999, // Temporary ID for testing
      farmer: referringFarmer._id,
      salesPerson: new mongoose.Types.ObjectId(), // You'll need a valid sales person ID
      numberOfPlants: 100,
      plantName: new mongoose.Types.ObjectId(), // You'll need a valid plant ID
      plantSubtype: new mongoose.Types.ObjectId(), // You'll need a valid plant subtype ID
      bookingSlot: new mongoose.Types.ObjectId(), // You'll need a valid slot ID
      rate: 50,
      orderFor: {
        name: "Jane Smith",
        address: "123 Main Street, Test City",
        mobileNumber: 8765432109
      }
    });
    
    console.log("Created order with 'order for' field:", orderWithOrderFor._id);
    console.log("Order for details:", orderWithOrderFor.orderFor);

    // Test 3: Update referring farmer's referredTo array
    console.log("\n=== Test 3: Testing referral functionality ===");
    
    const referredFarmer = await Farmer.create({
      name: "Bob Wilson",
      mobileNumber: 7654321098,
      village: "Another Village",
      taluka: "Another Taluka",
      district: "Another District", 
      state: "Maharashtra",
      talukaName: "Another Taluka",
      districtName: "Another District",
      stateName: "Maharashtra"
    });

    // Simulate adding a referral
    await Farmer.findByIdAndUpdate(
      referringFarmer._id,
      {
        $push: {
          referredTo: {
            farmerId: referredFarmer._id,
            orderId: orderWithOrderFor._id,
            referredAt: new Date()
          }
        }
      }
    );

    // Verify the referral was added
    const updatedReferringFarmer = await Farmer.findById(referringFarmer._id);
    console.log("Referring farmer's referredTo array:", updatedReferringFarmer.referredTo);

    console.log("\n=== All tests completed successfully! ===");
    
  } catch (error) {
    console.error("Test failed:", error);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

// Run the test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testNewFields();
}

export { testNewFields };
