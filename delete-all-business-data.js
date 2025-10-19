import mongoose from "mongoose";
import dotenv from "dotenv";
import Order from "./models/order.model.js";
import DealerWallet from "./models/dealerWallet.js";
import { 
  Product, 
  InventoryBatch, 
  InventoryInward, 
  InventoryOutward, 
  StockAdjustment 
} from "./models/inventory.model.js";
import Farmer from "./models/farmer.model.js";
import PlantSlot from "./models/slots.model.js";
import Dispatch from "./models/dispatch.model.js";

dotenv.config();

const deleteAllBusinessData = async () => {
  try {
    console.log("🔄 Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URL);
    console.log("✅ Connected to MongoDB successfully");

    console.log("\n" + "=".repeat(60));
    console.log("⚠️  WARNING: This will delete all business data!");
    console.log("=".repeat(60));
    console.log("This script will delete:");
    console.log("  1. All Orders");
    console.log("  2. All Dealer Wallet Records & Transactions");
    console.log("  3. All Inventory Data (Products, Batches, Inward, Outward, Adjustments)");
    console.log("  4. All Farmers");
    console.log("  5. All Dispatches");
    console.log("  6. Reset All Slots (clear bookings, reset availability)");
    console.log("\nPreserving:");
    console.log("  ✓ Users");
    console.log("  ✓ Plant CMS");
    console.log("  ✓ Location data (States, Districts, Villages)");
    console.log("  ✓ Other configuration data");
    console.log("=".repeat(60) + "\n");

    // Get counts before deletion
    console.log("📊 Current database statistics:");
    const orderCount = await Order.countDocuments();
    const dealerWalletCount = await DealerWallet.countDocuments();
    const productCount = await Product.countDocuments();
    const inventoryBatchCount = await InventoryBatch.countDocuments();
    const inventoryInwardCount = await InventoryInward.countDocuments();
    const inventoryOutwardCount = await InventoryOutward.countDocuments();
    const stockAdjustmentCount = await StockAdjustment.countDocuments();
    const farmerCount = await Farmer.countDocuments();
    const dispatchCount = await Dispatch.countDocuments();
    const slotCount = await PlantSlot.countDocuments();

    console.log(`  Orders: ${orderCount}`);
    console.log(`  Dealer Wallets: ${dealerWalletCount}`);
    console.log(`  Products: ${productCount}`);
    console.log(`  Inventory Batches: ${inventoryBatchCount}`);
    console.log(`  Inventory Inward: ${inventoryInwardCount}`);
    console.log(`  Inventory Outward: ${inventoryOutwardCount}`);
    console.log(`  Stock Adjustments: ${stockAdjustmentCount}`);
    console.log(`  Farmers: ${farmerCount}`);
    console.log(`  Dispatches: ${dispatchCount}`);
    console.log(`  Plant Slots: ${slotCount}\n`);

    // Wait 3 seconds to allow user to cancel if needed
    console.log("⏳ Starting deletion in 3 seconds... (Press Ctrl+C to cancel)");
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log("\n🗑️  Starting deletion process...\n");

    // 1. Delete all orders
    console.log("1️⃣  Deleting all orders...");
    const orderDeleteResult = await Order.deleteMany({});
    console.log(`   ✅ Deleted ${orderDeleteResult.deletedCount} orders`);

    // 2. Delete all dealer wallets
    console.log("2️⃣  Deleting all dealer wallet records...");
    const walletDeleteResult = await DealerWallet.deleteMany({});
    console.log(`   ✅ Deleted ${walletDeleteResult.deletedCount} dealer wallet records`);

    // 3. Delete all inventory data
    console.log("3️⃣  Deleting all inventory data...");
    
    const productDeleteResult = await Product.deleteMany({});
    console.log(`   ✅ Deleted ${productDeleteResult.deletedCount} products`);

    const batchDeleteResult = await InventoryBatch.deleteMany({});
    console.log(`   ✅ Deleted ${batchDeleteResult.deletedCount} inventory batches`);

    const inwardDeleteResult = await InventoryInward.deleteMany({});
    console.log(`   ✅ Deleted ${inwardDeleteResult.deletedCount} inventory inward records`);

    const outwardDeleteResult = await InventoryOutward.deleteMany({});
    console.log(`   ✅ Deleted ${outwardDeleteResult.deletedCount} inventory outward records`);

    const adjustmentDeleteResult = await StockAdjustment.deleteMany({});
    console.log(`   ✅ Deleted ${adjustmentDeleteResult.deletedCount} stock adjustments`);

    // 4. Delete all farmers
    console.log("4️⃣  Deleting all farmers...");
    const farmerDeleteResult = await Farmer.deleteMany({});
    console.log(`   ✅ Deleted ${farmerDeleteResult.deletedCount} farmers`);

    // 5. Delete all dispatches
    console.log("5️⃣  Deleting all dispatches...");
    const dispatchDeleteResult = await Dispatch.deleteMany({});
    console.log(`   ✅ Deleted ${dispatchDeleteResult.deletedCount} dispatches`);

    // 6. Reset all slots
    console.log("6️⃣  Resetting all plant slots...");
    const plantSlots = await PlantSlot.find({});
    let totalSlotsReset = 0;

    for (const plantSlot of plantSlots) {
      let slotsModified = false;
      
      if (plantSlot.subtypeSlots && plantSlot.subtypeSlots.length > 0) {
        plantSlot.subtypeSlots.forEach(subtypeSlot => {
          if (subtypeSlot.slots && subtypeSlot.slots.length > 0) {
            subtypeSlot.slots.forEach(slot => {
              // Clear orders array
              if (slot.orders && slot.orders.length > 0) {
                slot.orders = [];
                slotsModified = true;
              }
              
              // Reset booked plants
              if (slot.totalBookedPlants !== 0) {
                slot.totalBookedPlants = 0;
                slotsModified = true;
              }
              
              // Reset available plants to total plants minus buffer
              const bufferAmount = slot.bufferAmount || 0;
              const expectedAvailable = slot.totalPlants - bufferAmount;
              
              if (slot.availablePlants !== expectedAvailable) {
                slot.availablePlants = expectedAvailable;
                slotsModified = true;
              }
              
              // Reset overflow flag
              if (slot.isOverflow) {
                slot.isOverflow = false;
                slotsModified = true;
              }
              
              if (slot.overflow) {
                slot.overflow = false;
                slotsModified = true;
              }
              
              totalSlotsReset++;
            });
          }
        });
      }
      
      if (slotsModified) {
        await plantSlot.save();
      }
    }
    console.log(`   ✅ Reset ${totalSlotsReset} slots`);

    console.log("\n" + "=".repeat(60));
    console.log("✨ DELETION SUMMARY");
    console.log("=".repeat(60));
    console.log(`Orders deleted:              ${orderDeleteResult.deletedCount}`);
    console.log(`Dealer wallets deleted:      ${walletDeleteResult.deletedCount}`);
    console.log(`Products deleted:            ${productDeleteResult.deletedCount}`);
    console.log(`Inventory batches deleted:   ${batchDeleteResult.deletedCount}`);
    console.log(`Inventory inward deleted:    ${inwardDeleteResult.deletedCount}`);
    console.log(`Inventory outward deleted:   ${outwardDeleteResult.deletedCount}`);
    console.log(`Stock adjustments deleted:   ${adjustmentDeleteResult.deletedCount}`);
    console.log(`Farmers deleted:             ${farmerDeleteResult.deletedCount}`);
    console.log(`Dispatches deleted:          ${dispatchDeleteResult.deletedCount}`);
    console.log(`Slots reset:                 ${totalSlotsReset}`);
    console.log("=".repeat(60));

    // Verify deletion
    console.log("\n🔍 Verifying deletion...");
    const remainingOrders = await Order.countDocuments();
    const remainingWallets = await DealerWallet.countDocuments();
    const remainingProducts = await Product.countDocuments();
    const remainingBatches = await InventoryBatch.countDocuments();
    const remainingInward = await InventoryInward.countDocuments();
    const remainingOutward = await InventoryOutward.countDocuments();
    const remainingAdjustments = await StockAdjustment.countDocuments();
    const remainingFarmers = await Farmer.countDocuments();
    const remainingDispatches = await Dispatch.countDocuments();

    console.log("\n📊 Remaining documents:");
    console.log(`  Orders: ${remainingOrders}`);
    console.log(`  Dealer Wallets: ${remainingWallets}`);
    console.log(`  Products: ${remainingProducts}`);
    console.log(`  Inventory Batches: ${remainingBatches}`);
    console.log(`  Inventory Inward: ${remainingInward}`);
    console.log(`  Inventory Outward: ${remainingOutward}`);
    console.log(`  Stock Adjustments: ${remainingAdjustments}`);
    console.log(`  Farmers: ${remainingFarmers}`);
    console.log(`  Dispatches: ${remainingDispatches}`);

    if (
      remainingOrders === 0 &&
      remainingWallets === 0 &&
      remainingProducts === 0 &&
      remainingBatches === 0 &&
      remainingInward === 0 &&
      remainingOutward === 0 &&
      remainingAdjustments === 0 &&
      remainingFarmers === 0 &&
      remainingDispatches === 0
    ) {
      console.log("\n✅ All business data successfully deleted!");
      console.log("✅ All slots successfully reset!");
      console.log("✅ Database is now clean and ready for fresh data!");
    } else {
      console.log("\n⚠️  Warning: Some documents may still remain. Please verify manually.");
    }

  } catch (error) {
    console.error("\n❌ Error during deletion:", error);
    console.error("Stack trace:", error.stack);
  } finally {
    console.log("\n🔌 Disconnecting from MongoDB...");
    await mongoose.disconnect();
    console.log("✅ Disconnected from MongoDB");
    process.exit(0);
  }
};

// Run the deletion
deleteAllBusinessData();

