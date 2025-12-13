import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Connect to MongoDB
const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGO_URL or MONGODB_URI environment variable is required.');
    }
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Delete all orders and reset slots for reimport
const deleteAllOrdersAndReset = async () => {
  try {
    // Import models
    const { default: Order } = await import('./models/order.model.js');
    const { default: DealerOrder } = await import('./models/dealerOrder.model.js');
    const { default: PlantSlot } = await import('./models/slots.model.js');
    const Dispatch = mongoose.models.Dispatch || (await import('./models/dispatch.model.js')).default;
    const DealerBooking = mongoose.models.DealerBooking || (await import('./models/dealerBooking.model.js')).default;
    const DealerWallet = mongoose.models.DealerWallet || (await import('./models/dealerWallet.model.js')).default;

    console.log('\n' + '='.repeat(70));
    console.log('🗑️  DELETE ALL ORDERS AND RESET SLOTS FOR REIMPORT');
    console.log('='.repeat(70));
    console.log('\n⚠️  WARNING: This will permanently delete:');
    console.log('   • All Orders');
    console.log('   • All Dealer Orders');
    console.log('   • All Dispatch Records');
    console.log('   • All Dealer Bookings');
    console.log('   • All Dealer Wallet Transactions');
    console.log('   • Reset all Slot Bookings (totalBookedPlants, orders array)');
    console.log('\n📋 This script will:');
    console.log('   ✓ Clear all order-related data');
    console.log('   ✓ Reset slot bookings to zero');
    console.log('   ✓ Clear slot orders arrays');
    console.log('   ✓ Reset slot overflow flags');
    console.log('   ✓ Prepare database for fresh order import');
    console.log('\n' + '='.repeat(70) + '\n');

    // Get counts before deletion
    console.log('📊 Counting existing data...\n');
    const orderCount = await Order.countDocuments({});
    const dealerOrderCount = await DealerOrder?.countDocuments({}) || 0;
    const dispatchCount = await Dispatch?.countDocuments({}) || 0;
    const dealerBookingCount = await DealerBooking?.countDocuments({}) || 0;
    const dealerWalletCount = await DealerWallet?.countDocuments({}) || 0;

    console.log(`   Orders: ${orderCount}`);
    console.log(`   Dealer Orders: ${dealerOrderCount}`);
    console.log(`   Dispatches: ${dispatchCount}`);
    console.log(`   Dealer Bookings: ${dealerBookingCount}`);
    console.log(`   Dealer Wallet Records: ${dealerWalletCount}\n`);

    if (orderCount === 0 && dealerOrderCount === 0) {
      console.log('ℹ️  No orders found. Proceeding with slot reset...\n');
    } else {
      // Wait 3 seconds to allow user to cancel
      console.log('⏳ Starting deletion in 3 seconds... (Press Ctrl+C to cancel)\n');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // Step 1: Delete all orders
    console.log('1️⃣  Deleting all orders...');
    if (orderCount > 0) {
      const orderResult = await Order.deleteMany({});
      console.log(`   ✅ Deleted ${orderResult.deletedCount} orders`);
    } else {
      console.log('   ✅ No orders to delete');
    }

    // Step 2: Delete dealer orders
    if (DealerOrder) {
      console.log('\n2️⃣  Deleting dealer orders...');
      if (dealerOrderCount > 0) {
        const dealerOrderResult = await DealerOrder.deleteMany({});
        console.log(`   ✅ Deleted ${dealerOrderResult.deletedCount} dealer orders`);
      } else {
        console.log('   ✅ No dealer orders to delete');
      }
    }

    // Step 3: Delete dispatch records
    if (Dispatch) {
      console.log('\n3️⃣  Deleting dispatch records...');
      if (dispatchCount > 0) {
        const dispatchResult = await Dispatch.deleteMany({});
        console.log(`   ✅ Deleted ${dispatchResult.deletedCount} dispatch records`);
      } else {
        console.log('   ✅ No dispatch records to delete');
      }
    }

    // Step 4: Delete dealer bookings
    if (DealerBooking) {
      console.log('\n4️⃣  Deleting dealer bookings...');
      if (dealerBookingCount > 0) {
        const dealerBookingResult = await DealerBooking.deleteMany({});
        console.log(`   ✅ Deleted ${dealerBookingResult.deletedCount} dealer bookings`);
      } else {
        console.log('   ✅ No dealer bookings to delete');
      }
    }

    // Step 5: Delete dealer wallet transactions
    if (DealerWallet) {
      console.log('\n5️⃣  Deleting dealer wallet records...');
      if (dealerWalletCount > 0) {
        const walletResult = await DealerWallet.deleteMany({});
        console.log(`   ✅ Deleted ${walletResult.deletedCount} dealer wallet records`);
      } else {
        console.log('   ✅ No dealer wallet records to delete');
      }
    }

    // Step 6: Reset all slots
    console.log('\n6️⃣  Resetting all slots to original capacity...');
    const plantSlots = await PlantSlot.find({});
    console.log(`   📊 Found ${plantSlots.length} plant slot configurations`);

    let resetCount = 0;
    let totalSlotsReset = 0;
    let slotsModified = false;

    for (const plantSlot of plantSlots) {
      let plantSlotModified = false;

      for (const subtypeSlot of plantSlot.subtypeSlots || []) {
        for (const slot of subtypeSlot.slots || []) {
          // Reset slot booking data
          if (slot.totalBookedPlants !== 0) {
            slot.totalBookedPlants = 0;
            plantSlotModified = true;
          }

          // Clear orders array
          if (slot.orders && slot.orders.length > 0) {
            slot.orders = [];
            plantSlotModified = true;
          }

          // Reset overflow flags
          if (slot.overflow) {
            slot.overflow = false;
            plantSlotModified = true;
          }

          if (slot.isOverflow) {
            slot.isOverflow = false;
            plantSlotModified = true;
          }

          // Reset status (if boolean, false means available)
          if (typeof slot.status === 'boolean' && slot.status === true) {
            slot.status = false;
            plantSlotModified = true;
          }

          totalSlotsReset++;
        }
      }

      if (plantSlotModified) {
        await plantSlot.save();
        resetCount++;
        slotsModified = true;
      }
    }

    console.log(`   ✅ Reset ${totalSlotsReset} slots across ${resetCount} plant configurations`);

    // Step 7: Verify cleanup
    console.log('\n7️⃣  Verifying cleanup...');
    const remainingOrders = await Order.countDocuments();
    const remainingDealerOrders = DealerOrder ? await DealerOrder.countDocuments() : 0;
    const remainingDispatches = Dispatch ? await Dispatch.countDocuments() : 0;

    console.log(`   📊 Remaining orders: ${remainingOrders}`);
    console.log(`   📊 Remaining dealer orders: ${remainingDealerOrders}`);
    console.log(`   📊 Remaining dispatches: ${remainingDispatches}`);

    // Check a sample slot to verify reset
    const samplePlantSlot = await PlantSlot.findOne({});
    if (samplePlantSlot) {
      const sampleSlot = samplePlantSlot.subtypeSlots?.[0]?.slots?.[0];
      if (sampleSlot) {
        console.log('\n   📋 Sample slot verification:');
        console.log(`      - totalBookedPlants: ${sampleSlot.totalBookedPlants} (should be 0)`);
        console.log(`      - orders count: ${sampleSlot.orders?.length || 0} (should be 0)`);
        console.log(`      - overflow: ${sampleSlot.overflow || false} (should be false)`);
        console.log(`      - isOverflow: ${sampleSlot.isOverflow || false} (should be false)`);
      }
    }

    // Final summary
    console.log('\n' + '='.repeat(70));
    console.log('✨ DELETION AND RESET SUMMARY');
    console.log('='.repeat(70));
    console.log(`✅ Orders deleted:              ${orderCount}`);
    console.log(`✅ Dealer Orders deleted:       ${dealerOrderCount}`);
    console.log(`✅ Dispatch records deleted:    ${dispatchCount}`);
    console.log(`✅ Dealer Bookings deleted:     ${dealerBookingCount}`);
    console.log(`✅ Dealer Wallet records deleted: ${dealerWalletCount}`);
    console.log(`✅ Slots reset:                 ${totalSlotsReset} slots`);
    console.log('='.repeat(70));

    console.log('\n🎉 Database cleanup completed successfully!');
    console.log('\n📝 NEXT STEPS FOR REIMPORT:');
    console.log('   1. Place your Excel/CSV file with order data in the project root or /uploads folder');
    console.log('   2. Run the import script:');
    console.log('      node import-all-booking.js');
    console.log('   3. Or use one of the specific import scripts:');
    console.log('      - node import-first-order.js');
    console.log('      - node import-second-order.js');
    console.log('      - node import-dec3-order.js');
    console.log('      - node import-dec4-order.js');
    console.log('\n💡 Tip: Make sure your Excel file matches the expected format');
    console.log('   Check the import script for required columns and date formats.\n');

  } catch (error) {
    console.error('\n❌ Error during cleanup:', error);
    console.error(error.stack);
    throw error;
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    await deleteAllOrdersAndReset();
    
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Script execution failed:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
};

// Run the script
main();




