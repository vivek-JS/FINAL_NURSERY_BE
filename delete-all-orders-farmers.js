import dotenv from "dotenv";
import mongoose from "mongoose";
import Order from "./models/order.model.js";
import Farmer from "./models/farmer.model.js";

dotenv.config();

const deleteAllOrdersAndFarmers = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URL);
    console.log("Connected to database");

    // Count existing records
    const orderCount = await Order.countDocuments();
    const farmerCount = await Farmer.countDocuments();

    console.log(`Found ${orderCount} orders and ${farmerCount} farmers`);

    if (orderCount === 0 && farmerCount === 0) {
      console.log("No orders or farmers to delete");
      return;
    }

    // Delete all orders
    if (orderCount > 0) {
      const orderResult = await Order.deleteMany({});
      console.log(`✅ Deleted ${orderResult.deletedCount} orders`);
    }

    // Delete all farmers
    if (farmerCount > 0) {
      const farmerResult = await Farmer.deleteMany({});
      console.log(`✅ Deleted ${farmerResult.deletedCount} farmers`);
    }

    // Verify deletion
    const remainingOrders = await Order.countDocuments();
    const remainingFarmers = await Farmer.countDocuments();

    console.log(`\n📊 Final Count:`);
    console.log(`Orders remaining: ${remainingOrders}`);
    console.log(`Farmers remaining: ${remainingFarmers}`);

    if (remainingOrders === 0 && remainingFarmers === 0) {
      console.log("\n🎉 Successfully deleted all orders and farmers!");
    } else {
      console.log("\n⚠️  Some records may still exist");
    }

  } catch (error) {
    console.error("❌ Error deleting orders and farmers:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from database");
  }
};

// Run the script
deleteAllOrdersAndFarmers(); 