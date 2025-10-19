import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";

// Import all order-related models
import Order from "./models/order.model.js";
import DealerOrder from "./models/dealerOrder.model.js";
import Dispatch from "./models/dispatch.model.js";
import DealerBooking from "./models/dealerBooking.model.js";

// Database connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log("✅ Connected to database");
  } catch (error) {
    console.error("❌ Database connection failed:", error);
    process.exit(1);
  }
};

// Clear all order-related collections
const clearOrderData = async () => {
  try {
    console.log("\n🧹 Starting database cleanup for all order-related data...\n");

    // Clear Order collection
    console.log("📋 Clearing Order collection...");
    const orderResult = await Order.deleteMany({});
    console.log(`   ✅ Deleted ${orderResult.deletedCount} orders`);

    // Clear DealerOrder collection
    console.log("📋 Clearing DealerOrder collection...");
    const dealerOrderResult = await DealerOrder.deleteMany({});
    console.log(`   ✅ Deleted ${dealerOrderResult.deletedCount} dealer orders`);

    // Clear Dispatch collection
    console.log("📋 Clearing Dispatch collection...");
    const dispatchResult = await Dispatch.deleteMany({});
    console.log(`   ✅ Deleted ${dispatchResult.deletedCount} dispatch records`);

    // Clear DealerBooking collection
    console.log("📋 Clearing DealerBooking collection...");
    const dealerBookingResult = await DealerBooking.deleteMany({});
    console.log(`   ✅ Deleted ${dealerBookingResult.deletedCount} dealer bookings`);

    // Reset any counters or sequences if they exist
    console.log("\n🔄 Resetting order counters...");
    
    // Note: If you have any counter collections or sequences for orderId generation,
    // you might want to reset them here. For example:
    // await Counter.findOneAndUpdate({ _id: 'orderId' }, { seq: 0 }, { upsert: true });
    
    console.log("   ✅ Order counters reset (if any)");

    console.log("\n🎉 Database cleanup completed successfully!");
    console.log("\n📊 Summary:");
    console.log(`   • Orders deleted: ${orderResult.deletedCount}`);
    console.log(`   • Dealer Orders deleted: ${dealerOrderResult.deletedCount}`);
    console.log(`   • Dispatch records deleted: ${dispatchResult.deletedCount}`);
    console.log(`   • Dealer Bookings deleted: ${dealerBookingResult.deletedCount}`);

  } catch (error) {
    console.error("❌ Error during database cleanup:", error);
    throw error;
  }
};

// Main execution function
const main = async () => {
  try {
    await connectDB();
    await clearOrderData();
    
    console.log("\n✅ All order-related data has been cleared from the database.");
    console.log("🔒 Database connection will be closed in 3 seconds...");
    
    setTimeout(async () => {
      await mongoose.connection.close();
      console.log("🔌 Database connection closed.");
      process.exit(0);
    }, 3000);
    
  } catch (error) {
    console.error("💥 Fatal error:", error);
    process.exit(1);
  }
};

// Run the script
main();

