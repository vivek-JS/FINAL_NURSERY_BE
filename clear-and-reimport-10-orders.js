import mongoose from "mongoose";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import XLSX from "xlsx";
import { importOrdersFromExcel } from "./controllers/excel.serveces.controller.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log("✅ MongoDB connected");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error.message);
    process.exit(1);
  }
};

const clearAllOrders = async () => {
  try {
    const Order = (await import("./models/order.model.js")).default;
    const DealerOrder = (await import("./models/dealerOrder.model.js")).default;
    const SellOrder = (await import("./models/sellOrder.model.js")).default;
    
    console.log("\n📊 Counting orders before deletion...\n");
    
    const ordersCount = await Order.countDocuments({});
    const dealerOrdersCount = await DealerOrder.countDocuments({});
    const sellOrdersCount = await SellOrder.countDocuments({});
    const totalCount = ordersCount + dealerOrdersCount + sellOrdersCount;
    
    console.log(`📦 Regular Orders: ${ordersCount}`);
    console.log(`📦 Dealer Orders: ${dealerOrdersCount}`);
    console.log(`📦 Sell Orders: ${sellOrdersCount}`);
    console.log(`📦 Total Orders: ${totalCount}\n`);
    
    if (totalCount === 0) {
      console.log("ℹ️  No orders found. Nothing to delete.\n");
      return;
    }
    
    console.log("🗑️  Deleting ALL orders...\n");
    
    const ordersResult = await Order.deleteMany({});
    console.log(`✅ Regular Orders: Deleted ${ordersResult.deletedCount}`);
    
    const dealerOrdersResult = await DealerOrder.deleteMany({});
    console.log(`✅ Dealer Orders: Deleted ${dealerOrdersResult.deletedCount}`);
    
    const sellOrdersResult = await SellOrder.deleteMany({});
    console.log(`✅ Sell Orders: Deleted ${sellOrdersResult.deletedCount}`);
    
    const totalDeleted = ordersResult.deletedCount + dealerOrdersResult.deletedCount + sellOrdersResult.deletedCount;
    console.log(`\n✅ Total deleted: ${totalDeleted} order documents\n`);
  } catch (error) {
    console.error("❌ Error deleting orders:", error.message);
    throw error;
  }
};

const import10Orders = async () => {
  try {
    const excelFilePath = path.join(__dirname, "fetch-excel", "BOOKING DETAILS 2025-26 Final (1).xlsx");
    
    if (!fs.existsSync(excelFilePath)) {
      throw new Error(`Excel file not found at: ${excelFilePath}`);
    }
    
    console.log(`📖 Reading Excel file: ${excelFilePath}`);
    const fileBuffer = fs.readFileSync(excelFilePath);
    
    const importBatchId = `import-${Date.now()}`;
    const sourceFilename = "BOOKING DETAILS 2025-26 Final (1).xlsx";
    const password = null; // No password for this file
    const rowLimit = 10;
    
    console.log(`\n📥 Importing first ${rowLimit} orders...\n`);
    
    const results = await importOrdersFromExcel(fileBuffer, {
      importBatchId,
      sourceFilename,
      password,
      rowLimit,
    });
    
    console.log("\n" + "=".repeat(60));
    console.log("📊 IMPORT SUMMARY");
    console.log("=".repeat(60));
    console.log(`✅ Successfully imported: ${results.success} orders`);
    console.log(`❌ Failed: ${results.failed} orders`);
    console.log(`⏭️  Skipped: ${results.skipped.length} orders`);
    
    if (results.errors.length > 0) {
      console.log(`\n❌ Errors:`);
      results.errors.forEach((error, index) => {
        console.log(`   ${index + 1}. ${error}`);
      });
    }
    
    if (results.autoCreatedFarmers && results.autoCreatedFarmers.length > 0) {
      console.log(`\n👨‍🌾 Auto-created ${results.autoCreatedFarmers.length} farmers`);
    }
    
    if (results.autoCreatedSalesPersons && results.autoCreatedSalesPersons.length > 0) {
      console.log(`\n👤 Auto-created ${results.autoCreatedSalesPersons.length} sales persons`);
    }
    
    if (results.autoCreatedTrays && results.autoCreatedTrays.length > 0) {
      console.log(`\n📦 Auto-created ${results.autoCreatedTrays.length} trays`);
    }
    
    if (results.autoCreatedReferenceUsers && results.autoCreatedReferenceUsers.length > 0) {
      console.log(`\n👥 Auto-created ${results.autoCreatedReferenceUsers.length} reference users`);
    }
    
    if (results.autoCreatedVarieties && results.autoCreatedVarieties.length > 0) {
      console.log(`\n🌱 Auto-created ${results.autoCreatedVarieties.length} plant varieties`);
    }
    
    console.log("\n" + "=".repeat(60));
    
    return results;
  } catch (error) {
    console.error("❌ Error importing orders:", error.message);
    throw error;
  }
};

const main = async () => {
  try {
    await connectDB();
    
    // Step 1: Clear all orders
    await clearAllOrders();
    
    // Step 2: Import 10 orders
    await import10Orders();
    
    console.log("\n✅ Process completed successfully!");
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





