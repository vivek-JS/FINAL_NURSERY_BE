import mongoose from "mongoose";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log("✅ MongoDB connected\n");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error.message);
    process.exit(1);
  }
};

const checkOrderStatuses = async () => {
  try {
    const Order = (await import("./models/order.model.js")).default;
    const Farmer = (await import("./models/farmer.model.js")).default;
    const User = (await import("./models/user.model.js")).default;
    
    // Get the 10 most recently imported orders
    const orders = await Order.find({})
      .sort({ createdAt: -1 })
      .limit(10)
      .populate("farmer", "name mobileNumber")
      .populate("salesPerson", "name")
      .lean();
    
    console.log("=".repeat(80));
    console.log("📊 ORDER STATUS VERIFICATION (Last 10 Imported Orders)");
    console.log("=".repeat(80));
    console.log();
    
    orders.forEach((order, index) => {
      console.log(`${index + 1}. Order ID: ${order.orderId}`);
      console.log(`   Farmer: ${order.farmer?.name || "N/A"} (${order.farmer?.mobileNumber || "N/A"})`);
      console.log(`   Sales Person: ${order.salesPerson?.name || "N/A"}`);
      console.log(`   Order Status: ${order.orderStatus}`);
      console.log(`   Payment Status: ${order.orderPaymentStatus}`);
      console.log(`   Payment Completed: ${order.paymentCompleted}`);
      console.log(`   Number of Payments: ${order.payment?.length || 0}`);
      if (order.payment && order.payment.length > 0) {
        order.payment.forEach((p, i) => {
          console.log(`      Payment ${i + 1}: ₹${p.paidAmount} - ${p.paymentStatus}`);
        });
      }
      console.log();
    });
    
    console.log("=".repeat(80));
    console.log(`Total Orders: ${orders.length}`);
    console.log("=".repeat(80));
    
  } catch (error) {
    console.error("❌ Error:", error.message);
    throw error;
  }
};

const main = async () => {
  try {
    await connectDB();
    await checkOrderStatuses();
  } catch (error) {
    console.error("\n❌ Process failed:", error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log("\n🔌 Database connection closed");
    process.exit(0);
  }
};

main();

