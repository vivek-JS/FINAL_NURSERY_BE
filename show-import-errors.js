import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log("✅ MongoDB connected\n");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error.message);
    process.exit(1);
  }
};

const showImportErrors = async () => {
  try {
    const ErrorfulOrder = (await import("./models/errorfulOrder.model.js")).default;
    
    // Get all errorful orders from the most recent import
    const errorfulOrders = await ErrorfulOrder.find({})
      .sort({ createdAt: -1 })
      .lean();
    
    console.log("=".repeat(80));
    console.log("📋 ERRORFUL ORDERS DETAILS");
    console.log("=".repeat(80));
    console.log(`\nTotal Errorful Orders: ${errorfulOrders.length}\n`);
    
    if (errorfulOrders.length === 0) {
      console.log("✅ No errorful orders found!\n");
      return;
    }
    
    // Group by error type
    const errorGroups = {};
    errorfulOrders.forEach(order => {
      const errorType = order.errorType || "UNKNOWN_ERROR";
      if (!errorGroups[errorType]) {
        errorGroups[errorType] = [];
      }
      errorGroups[errorType].push(order);
    });
    
    console.log("📊 Error Types Breakdown:");
    Object.entries(errorGroups).forEach(([type, orders]) => {
      console.log(`   ${type}: ${orders.length}`);
    });
    console.log();
    
    // Show details of each errorful order
    errorfulOrders.forEach((order, index) => {
      console.log(`${index + 1}. Row ${order.rowNumber}`);
      console.log(`   Booking Number: ${order.bookingNumber || "N/A"}`);
      console.log(`   Parsed Order ID: ${order.parsedOrderId || "N/A"}`);
      console.log(`   Error Type: ${order.errorType || "UNKNOWN"}`);
      console.log(`   Error Message: ${order.errorMessage}`);
      
      // Show raw data if available
      if (order.rawData) {
        const raw = order.rawData;
        console.log(`   Farmer Name: ${raw["Name"] || raw["Name\r\n"] || "N/A"}`);
        console.log(`   Mobile: ${raw["Mobile No."] || raw["Mobile\r\nNo."] || "N/A"}`);
        console.log(`   Crop: ${raw["Crop"] || "N/A"}`);
        console.log(`   Variety: ${raw["Variety"] || "N/A"}`);
        console.log(`   Plant Qty: ${raw["Plant Qty."] || raw["Plant\r\nQty."] || "N/A"}`);
        console.log(`   Expected Del. Date: ${raw["Expected Del."] || raw["Expected\r\nDel.\r\nDate"] || raw["Expected\r\nDel."] || "N/A"}`);
        console.log(`   Old Del. Date: ${raw["Old Del. Date"] || raw["Old\r\nDel. Date\r\n(If Changed)"] || "N/A"}`);
        console.log(`   Del. Y/N: ${raw["Del. Y/N"] || raw["Del.\r\nY/N"] || "N/A"}`);
      }
      
      console.log(`   Created At: ${new Date(order.createdAt).toLocaleString()}`);
      console.log(`   Resolved: ${order.isResolved ? "Yes" : "No"}`);
      if (order.isResolved && order.resolutionNotes) {
        console.log(`   Resolution Notes: ${order.resolutionNotes}`);
      }
      console.log();
    });
    
    // Show missing delivery date errors specifically
    const missingDateErrors = errorfulOrders.filter(order => 
      order.errorMessage && order.errorMessage.toLowerCase().includes("missing delivery date")
    );
    
    if (missingDateErrors.length > 0) {
      console.log("=".repeat(80));
      console.log("📅 ORDERS WITH MISSING DELIVERY DATES");
      console.log("=".repeat(80));
      console.log(`\nTotal: ${missingDateErrors.length} orders\n`);
      
      missingDateErrors.forEach((order, index) => {
        console.log(`${index + 1}. Row ${order.rowNumber}`);
        console.log(`   Booking Number: ${order.bookingNumber || "N/A"}`);
        if (order.rawData) {
          const raw = order.rawData;
          console.log(`   Farmer: ${raw["Name"] || raw["Name\r\n"] || "N/A"}`);
          console.log(`   Mobile: ${raw["Mobile No."] || raw["Mobile\r\nNo."] || "N/A"}`);
          console.log(`   Expected Del. Date: ${raw["Expected Del."] || raw["Expected\r\nDel.\r\nDate"] || raw["Expected\r\nDel."] || "EMPTY"}`);
          console.log(`   Old Del. Date: ${raw["Old Del. Date"] || raw["Old\r\nDel. Date\r\n(If Changed)"] || "EMPTY"}`);
        }
        console.log();
      });
    }
    
    console.log("=".repeat(80));
    
  } catch (error) {
    console.error("❌ Error:", error.message);
    throw error;
  }
};

const main = async () => {
  try {
    await connectDB();
    await showImportErrors();
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




