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

const showErrorExamples = async () => {
  try {
    const ErrorfulOrder = (await import("./models/errorfulOrder.model.js")).default;
    
    // Get errorful orders grouped by type
    const errorfulOrders = await ErrorfulOrder.find({})
      .sort({ createdAt: -1 })
      .lean();
    
    console.log("=".repeat(80));
    console.log("📋 ERROR EXAMPLES BY TYPE");
    console.log("=".repeat(80));
    console.log();
    
    // Group by error type
    const errorGroups = {};
    errorfulOrders.forEach(order => {
      const errorType = order.errorType || "UNKNOWN_ERROR";
      if (!errorGroups[errorType]) {
        errorGroups[errorType] = [];
      }
      errorGroups[errorType].push(order);
    });
    
    // Show DATE_ERROR examples
    if (errorGroups.DATE_ERROR && errorGroups.DATE_ERROR.length > 0) {
      console.log("=".repeat(80));
      console.log("📅 DATE_ERROR Examples (No Suitable Slot Found)");
      console.log("=".repeat(80));
      console.log(`Total: ${errorGroups.DATE_ERROR.length} orders\n`);
      
      // Show first 5 examples
      errorGroups.DATE_ERROR.slice(0, 5).forEach((order, index) => {
        const raw = order.rawData || {};
        console.log(`${index + 1}. Row ${order.rowNumber}`);
        console.log(`   Booking Number: ${order.bookingNumber || "N/A"}`);
        console.log(`   Farmer: ${raw["Name"] || raw["Name\r\n"] || "N/A"}`);
        console.log(`   Mobile: ${raw["Mobile No."] || raw["Mobile\r\nNo."] || "N/A"}`);
        console.log(`   Crop: ${raw["Crop"] || "N/A"}`);
        console.log(`   Variety: ${raw["Variety"] || "N/A"}`);
        console.log(`   Plant Qty: ${raw["Plant Qty."] || raw["Plant\r\nQty."] || "N/A"}`);
        console.log(`   Expected Del. Date: ${raw["Expected Del."] || raw["Expected\r\nDel.\r\nDate"] || raw["Expected\r\nDel."] || "N/A"}`);
        console.log(`   Old Del. Date: ${raw["Old Del. Date"] || raw["Old\r\nDel. Date\r\n(If Changed)"] || "N/A"}`);
        console.log(`   Error: ${order.errorMessage}`);
        console.log();
      });
    }
    
    // Show FARMER_ERROR examples
    if (errorGroups.FARMER_ERROR && errorGroups.FARMER_ERROR.length > 0) {
      console.log("=".repeat(80));
      console.log("👨‍🌾 FARMER_ERROR Examples (Missing Location Data)");
      console.log("=".repeat(80));
      console.log(`Total: ${errorGroups.FARMER_ERROR.length} orders\n`);
      
      // Show all examples
      errorGroups.FARMER_ERROR.forEach((order, index) => {
        const raw = order.rawData || {};
        console.log(`${index + 1}. Row ${order.rowNumber}`);
        console.log(`   Booking Number: ${order.bookingNumber || "N/A"}`);
        console.log(`   Farmer Name: ${raw["Name"] || raw["Name\r\n"] || "N/A"}`);
        console.log(`   Mobile: ${raw["Mobile No."] || raw["Mobile\r\nNo."] || "N/A"}`);
        console.log(`   Address: ${raw["Address"] || "N/A"}`);
        console.log(`   Taluka: ${raw["Taluka"] || "N/A"}`);
        console.log(`   District: ${raw["District"] || "N/A"}`);
        console.log(`   Error: ${order.errorMessage}`);
        console.log();
      });
    }
    
    // Show PLANT_ERROR examples
    if (errorGroups.PLANT_ERROR && errorGroups.PLANT_ERROR.length > 0) {
      console.log("=".repeat(80));
      console.log("🌱 PLANT_ERROR Examples (Variety/Slot Issues)");
      console.log("=".repeat(80));
      console.log(`Total: ${errorGroups.PLANT_ERROR.length} orders\n`);
      
      // Show first 5 examples
      errorGroups.PLANT_ERROR.slice(0, 5).forEach((order, index) => {
        const raw = order.rawData || {};
        console.log(`${index + 1}. Row ${order.rowNumber}`);
        console.log(`   Booking Number: ${order.bookingNumber || "N/A"}`);
        console.log(`   Farmer: ${raw["Name"] || raw["Name\r\n"] || "N/A"}`);
        console.log(`   Mobile: ${raw["Mobile No."] || raw["Mobile\r\nNo."] || "N/A"}`);
        console.log(`   Crop: ${raw["Crop"] || "N/A"}`);
        console.log(`   Variety: ${raw["Variety"] || "N/A"}`);
        console.log(`   Plant Qty: ${raw["Plant Qty."] || raw["Plant\r\nQty."] || "N/A"}`);
        console.log(`   Error: ${order.errorMessage.substring(0, 200)}${order.errorMessage.length > 200 ? "..." : ""}`);
        console.log();
      });
    }
    
    // Show MISSING_DATA examples
    if (errorGroups.MISSING_DATA && errorGroups.MISSING_DATA.length > 0) {
      console.log("=".repeat(80));
      console.log("❌ MISSING_DATA Examples");
      console.log("=".repeat(80));
      console.log(`Total: ${errorGroups.MISSING_DATA.length} orders\n`);
      
      // Show first 5 examples
      errorGroups.MISSING_DATA.slice(0, 5).forEach((order, index) => {
        const raw = order.rawData || {};
        console.log(`${index + 1}. Row ${order.rowNumber}`);
        console.log(`   Booking Number: ${order.bookingNumber || "N/A"}`);
        console.log(`   Farmer: ${raw["Name"] || raw["Name\r\n"] || "N/A"}`);
        console.log(`   Mobile: ${raw["Mobile No."] || raw["Mobile\r\nNo."] || "N/A"}`);
        console.log(`   Error: ${order.errorMessage.substring(0, 150)}${order.errorMessage.length > 150 ? "..." : ""}`);
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
    await showErrorExamples();
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




