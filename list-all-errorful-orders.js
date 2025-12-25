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

const listAllErrorfulOrders = async () => {
  try {
    const ErrorfulOrder = (await import("./models/errorfulOrder.model.js")).default;
    
    // Get all errorful orders sorted by row number
    const errorfulOrders = await ErrorfulOrder.find({})
      .sort({ rowNumber: 1, createdAt: -1 })
      .lean();
    
    console.log("=".repeat(100));
    console.log("📋 ALL ERRORFUL ORDERS - COMPLETE LIST");
    console.log("=".repeat(100));
    console.log(`\nTotal Errorful Orders: ${errorfulOrders.length}\n`);
    
    if (errorfulOrders.length === 0) {
      console.log("✅ No errorful orders found!\n");
      return;
    }
    
    // Group by error type for summary
    const errorGroups = {};
    errorfulOrders.forEach(order => {
      const errorType = order.errorType || "UNKNOWN_ERROR";
      if (!errorGroups[errorType]) {
        errorGroups[errorType] = 0;
      }
      errorGroups[errorType]++;
    });
    
    console.log("📊 Error Types Summary:");
    Object.entries(errorGroups).forEach(([type, count]) => {
      console.log(`   ${type}: ${count}`);
    });
    console.log();
    
    // List all orders
    errorfulOrders.forEach((order, index) => {
      const raw = order.rawData || {};
      
      console.log(`${index + 1}. Row ${order.rowNumber}`);
      console.log(`   ┌─ Booking Number: ${order.bookingNumber || "N/A"}`);
      console.log(`   ├─ Parsed Order ID: ${order.parsedOrderId || "N/A"}`);
      console.log(`   ├─ Error Type: ${order.errorType || "UNKNOWN"}`);
      console.log(`   ├─ Farmer Name: ${raw["Name"] || raw["Name\r\n"] || "N/A"}`);
      console.log(`   ├─ Mobile: ${raw["Mobile No."] || raw["Mobile\r\nNo."] || "N/A"}`);
      console.log(`   ├─ Address: ${raw["Address"] || "N/A"}`);
      console.log(`   ├─ Taluka: ${raw["Taluka"] || "N/A"}`);
      console.log(`   ├─ District: ${raw["District"] || "N/A"}`);
      console.log(`   ├─ Crop: ${raw["Crop"] || "N/A"}`);
      console.log(`   ├─ Variety: ${raw["Variety"] || "N/A"}`);
      console.log(`   ├─ Media: ${raw["Media"] || "N/A"}`);
      console.log(`   ├─ Plant Qty: ${raw["Plant Qty."] || raw["Plant\r\nQty."] || "N/A"}`);
      console.log(`   ├─ Rate: ${raw["Rate"] || "N/A"}`);
      console.log(`   ├─ Expected Del. Date: ${raw["Expected Del."] || raw["Expected\r\nDel.\r\nDate"] || raw["Expected\r\nDel."] || "N/A"}`);
      console.log(`   ├─ Old Del. Date: ${raw["Old Del. Date"] || raw["Old\r\nDel. Date\r\n(If Changed)"] || "N/A"}`);
      console.log(`   ├─ Del. Y/N: ${raw["Del. Y/N"] || raw["Del.\r\nY/N"] || "N/A"}`);
      console.log(`   ├─ Order By: ${raw["Order By"] || raw["Order\r\nBy"] || "N/A"}`);
      console.log(`   ├─ Reference: ${raw["Refrence"] || "N/A"}`);
      console.log(`   ├─ Advance Amt: ${raw["Advance On Booking Receipts"] || raw["Advance\r\nAmt."] || raw["Advance Amt."] || "N/A"}`);
      console.log(`   ├─ ADV Y/N: ${raw["ADV Y/N"] || raw["ADV\r\nY/N"] || "N/A"}`);
      console.log(`   ├─ Error Message: ${order.errorMessage}`);
      console.log(`   ├─ Created At: ${new Date(order.createdAt).toLocaleString()}`);
      console.log(`   ├─ Resolved: ${order.isResolved ? "Yes" : "No"}`);
      if (order.isResolved && order.resolutionNotes) {
        console.log(`   ├─ Resolution Notes: ${order.resolutionNotes}`);
      }
      console.log(`   └─ Import Batch: ${order.importBatchId || "N/A"}`);
      console.log();
    });
    
    console.log("=".repeat(100));
    console.log(`Total: ${errorfulOrders.length} errorful orders`);
    console.log("=".repeat(100));
    
  } catch (error) {
    console.error("❌ Error:", error.message);
    throw error;
  }
};

const main = async () => {
  try {
    await connectDB();
    await listAllErrorfulOrders();
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

