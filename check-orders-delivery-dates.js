import mongoose from "mongoose";
import dotenv from "dotenv";
import Order from "./models/order.model.js";

// Load environment variables
dotenv.config();

const MONGODB_URI = process.env.MONGO_URL || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/nursery";

async function checkOrdersDeliveryDates() {
  try {
    console.log("===========================================");
    console.log("Check Orders and Delivery Dates");
    console.log("===========================================\n");

    // Connect to MongoDB
    console.log("Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB successfully\n");

    // Get total count
    const totalOrders = await Order.countDocuments();
    console.log(`Total orders in database: ${totalOrders}\n`);

    if (totalOrders === 0) {
      console.log("⚠️  No orders found in database");
      await mongoose.connection.close();
      return;
    }

    // Get orders with delivery dates
    const ordersWithDeliveryDate = await Order.countDocuments({ 
      deliveryDate: { $exists: true, $ne: null } 
    });
    console.log(`Orders with delivery date: ${ordersWithDeliveryDate}`);
    console.log(`Orders without delivery date: ${totalOrders - ordersWithDeliveryDate}\n`);

    // Get date range of all orders
    const dateStats = await Order.aggregate([
      {
        $match: { deliveryDate: { $exists: true, $ne: null } }
      },
      {
        $group: {
          _id: null,
          earliestDelivery: { $min: "$deliveryDate" },
          latestDelivery: { $max: "$deliveryDate" },
          count: { $sum: 1 }
        }
      }
    ]);

    if (dateStats.length > 0) {
      const stats = dateStats[0];
      console.log("Delivery Date Range:");
      console.log("═══════════════════════════════════════════════════════════════════");
      console.log(`Earliest: ${stats.earliestDelivery ? new Date(stats.earliestDelivery).toISOString().split('T')[0] : 'N/A'}`);
      console.log(`Latest:   ${stats.latestDelivery ? new Date(stats.latestDelivery).toISOString().split('T')[0] : 'N/A'}`);
      console.log(`Count:    ${stats.count}`);
      console.log("═══════════════════════════════════════════════════════════════════\n");
    }

    // Get sample orders
    const sampleOrders = await Order.find({ deliveryDate: { $exists: true, $ne: null } })
      .select('orderId deliveryDate orderStatus numberOfPlants rate farmer salesPerson')
      .populate('farmer', 'name village')
      .populate('salesPerson', 'name')
      .sort({ deliveryDate: -1 })
      .limit(10);

    if (sampleOrders.length > 0) {
      console.log("Sample Orders (Most Recent Delivery Dates):");
      console.log("═══════════════════════════════════════════════════════════════════");
      sampleOrders.forEach((order, index) => {
        const deliveryDateStr = order.deliveryDate ? 
          new Date(order.deliveryDate).toISOString().split('T')[0] : 'N/A';
        console.log(`${index + 1}. Order ID: ${order.orderId}`);
        console.log(`   Delivery Date: ${deliveryDateStr}`);
        console.log(`   Status:        ${order.orderStatus || 'N/A'}`);
        console.log(`   Plants:        ${order.numberOfPlants || 0}`);
        console.log(`   Farmer:        ${order.farmer?.name || 'N/A'} (${order.farmer?.village || 'N/A'})`);
        console.log(`   Sales Person:  ${order.salesPerson?.name || 'N/A'}`);
        console.log("");
      });
      console.log("═══════════════════════════════════════════════════════════════════\n");
    }

    // Get orders by status
    const statusCounts = await Order.aggregate([
      {
        $group: {
          _id: "$orderStatus",
          count: { $sum: 1 }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);

    console.log("Orders by Status:");
    console.log("═══════════════════════════════════════════════════════════════════");
    statusCounts.forEach(status => {
      console.log(`${status._id || 'NO_STATUS'}: ${status.count} order(s)`);
    });
    console.log("═══════════════════════════════════════════════════════════════════\n");

    // Close connection
    await mongoose.connection.close();
    console.log("✓ MongoDB connection closed");
    
  } catch (error) {
    console.error("\n❌ ERROR:", error.message);
    console.error(error);
    
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
    }
    
    process.exit(1);
  }
}

// Run the script
checkOrdersDeliveryDates();

