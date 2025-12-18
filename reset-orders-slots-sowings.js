import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGO_URL or MONGODB_URI environment variable is required.');
    }
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
};

const resetOrdersSlotsSowings = async () => {
  try {
    await connectDB();
    
    // Import all models
    const Order = (await import('./models/order.model.js')).default;
    const DealerOrder = (await import('./models/dealerOrder.model.js')).default;
    const SellOrder = (await import('./models/sellOrder.model.js')).default;
    const Sowing = (await import('./models/sowing.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    console.log('\n📊 Counting data before reset...\n');
    
    // Count before deletion
    const ordersCount = await Order.countDocuments({});
    const dealerOrdersCount = await DealerOrder.countDocuments({});
    const sellOrdersCount = await SellOrder.countDocuments({});
    const sowingsCount = await Sowing.countDocuments({});
    
    // Count slot data
    const slotSummary = await PlantSlot.aggregate([
      {
        $unwind: "$subtypeSlots"
      },
      {
        $unwind: "$subtypeSlots.slots"
      },
      {
        $group: {
          _id: null,
          totalCapacity: { $sum: "$subtypeSlots.slots.totalPlants" },
          totalBooked: { $sum: "$subtypeSlots.slots.totalBookedPlants" },
          totalPlantsSowed: { $sum: "$subtypeSlots.slots.plantsSowed" },
          totalOfficeSowed: { $sum: "$subtypeSlots.slots.officeSowed" },
          totalPrimarySowed: { $sum: "$subtypeSlots.slots.primarySowed" },
          slotsWithCapacity: {
            $sum: {
              $cond: [{ $gt: ["$subtypeSlots.slots.totalPlants", 0] }, 1, 0]
            }
          },
          slotsWithBooked: {
            $sum: {
              $cond: [{ $gt: ["$subtypeSlots.slots.totalBookedPlants", 0] }, 1, 0]
            }
          },
          slotsWithSowed: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $gt: ["$subtypeSlots.slots.plantsSowed", 0] },
                    { $gt: ["$subtypeSlots.slots.officeSowed", 0] },
                    { $gt: ["$subtypeSlots.slots.primarySowed", 0] }
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      }
    ]);
    
    const slotStats = slotSummary.length > 0 ? slotSummary[0] : {
      totalCapacity: 0,
      totalBooked: 0,
      totalPlantsSowed: 0,
      totalOfficeSowed: 0,
      totalPrimarySowed: 0,
      slotsWithCapacity: 0,
      slotsWithBooked: 0,
      slotsWithSowed: 0
    };
    
    console.log('📦 Before Reset Summary:');
    console.log(`   Orders: ${ordersCount}`);
    console.log(`   Dealer Orders: ${dealerOrdersCount}`);
    console.log(`   Sell Orders: ${sellOrdersCount}`);
    console.log(`   Sowings: ${sowingsCount}`);
    console.log(`   Total Orders: ${ordersCount + dealerOrdersCount + sellOrdersCount}`);
    console.log(`\n   Slot Capacity: ${(slotStats.totalCapacity || 0).toLocaleString()}`);
    console.log(`   Slot Booked: ${(slotStats.totalBooked || 0).toLocaleString()}`);
    console.log(`   Slot Plants Sowed: ${(slotStats.totalPlantsSowed || 0).toLocaleString()}`);
    console.log(`   Slot Office Sowed: ${(slotStats.totalOfficeSowed || 0).toLocaleString()}`);
    console.log(`   Slot Primary Sowed: ${(slotStats.totalPrimarySowed || 0).toLocaleString()}`);
    console.log(`   Slots with Capacity: ${slotStats.slotsWithCapacity || 0}`);
    console.log(`   Slots with Booked: ${slotStats.slotsWithBooked || 0}`);
    console.log(`   Slots with Sowed: ${slotStats.slotsWithSowed || 0}\n`);
    
    const totalToClean = ordersCount + dealerOrdersCount + sellOrdersCount + sowingsCount;
    const hasSlotData = (slotStats.totalCapacity || 0) > 0 || 
                       (slotStats.totalBooked || 0) > 0 || 
                       (slotStats.totalPlantsSowed || 0) > 0 ||
                       (slotStats.totalOfficeSowed || 0) > 0 ||
                       (slotStats.totalPrimarySowed || 0) > 0;
    
    if (totalToClean === 0 && !hasSlotData) {
      console.log('ℹ️  No data to clean. Everything is already reset.');
      await mongoose.connection.close();
      return;
    }
    
    console.log('🗑️  Starting cleanup process...\n');
    
    // Step 1: Delete all orders
    console.log('📦 Step 1: Deleting all orders...');
    const ordersResult = await Order.deleteMany({});
    console.log(`   ✅ Regular Orders: Deleted ${ordersResult.deletedCount} documents`);
    
    const dealerOrdersResult = await DealerOrder.deleteMany({});
    console.log(`   ✅ Dealer Orders: Deleted ${dealerOrdersResult.deletedCount} documents`);
    
    const sellOrdersResult = await SellOrder.deleteMany({});
    console.log(`   ✅ Sell Orders: Deleted ${sellOrdersResult.deletedCount} documents`);
    
    const totalOrdersDeleted = ordersResult.deletedCount + dealerOrdersResult.deletedCount + sellOrdersResult.deletedCount;
    console.log(`   ✅ Total Orders Deleted: ${totalOrdersDeleted}\n`);
    
    // Step 2: Delete all sowings
    console.log('🌱 Step 2: Deleting all sowings...');
    const sowingsResult = await Sowing.deleteMany({});
    console.log(`   ✅ Sowings: Deleted ${sowingsResult.deletedCount} documents\n`);
    
    // Step 3: Reset all slot fields
    console.log('🔄 Step 3: Resetting all slot fields...');
    
    const allSlots = await PlantSlot.find({}).lean();
    let totalSlotDocsUpdated = 0;
    let totalCapacityReset = 0;
    let totalBookedReset = 0;
    let totalPlantsSowedReset = 0;
    let totalOfficeSowedReset = 0;
    let totalPrimarySowedReset = 0;
    
    for (const slotDoc of allSlots) {
      let needsUpdate = false;
      const updatedSubtypeSlots = slotDoc.subtypeSlots?.map(subtypeSlot => {
        const updatedSlots = subtypeSlot.slots?.map(slot => {
          const hadCapacity = (slot.totalPlants || 0) > 0;
          const hadBooked = (slot.totalBookedPlants || 0) > 0;
          const hadPlantsSowed = (slot.plantsSowed || 0) > 0;
          const hadOfficeSowed = (slot.officeSowed || 0) > 0;
          const hadPrimarySowed = (slot.primarySowed || 0) > 0;
          
          if (hadCapacity || hadBooked || hadPlantsSowed || hadOfficeSowed || hadPrimarySowed) {
            needsUpdate = true;
            totalCapacityReset += (slot.totalPlants || 0);
            totalBookedReset += (slot.totalBookedPlants || 0);
            totalPlantsSowedReset += (slot.plantsSowed || 0);
            totalOfficeSowedReset += (slot.officeSowed || 0);
            totalPrimarySowedReset += (slot.primarySowed || 0);
            
            return {
              ...slot,
              totalPlants: 0,
              totalBookedPlants: 0,
              availablePlants: 0,
              plantsSowed: 0,
              officeSowed: 0,
              primarySowed: 0,
              sowingDate: null,
              plantReadyDate: null,
              reminderBeforePlantReadyDays: 0
            };
          }
          return slot;
        });
        
        return {
          ...subtypeSlot,
          slots: updatedSlots
        };
      });
      
      if (needsUpdate) {
        await PlantSlot.updateOne(
          { _id: slotDoc._id },
          { $set: { subtypeSlots: updatedSubtypeSlots } }
        );
        totalSlotDocsUpdated++;
      }
    }
    
    console.log(`   ✅ Updated ${totalSlotDocsUpdated} slot documents`);
    console.log(`   ✅ Reset Capacity: ${totalCapacityReset.toLocaleString()} plants`);
    console.log(`   ✅ Reset Stored Booked: ${totalBookedReset.toLocaleString()} plants`);
    console.log(`   ✅ Reset Plants Sowed: ${totalPlantsSowedReset.toLocaleString()} plants`);
    console.log(`   ✅ Reset Office Sowed: ${totalOfficeSowedReset.toLocaleString()} plants`);
    console.log(`   ✅ Reset Primary Sowed: ${totalPrimarySowedReset.toLocaleString()} plants\n`);
    
    // Final verification
    console.log('🔍 Final Verification...\n');
    
    const finalOrdersCount = await Order.countDocuments({});
    const finalDealerOrdersCount = await DealerOrder.countDocuments({});
    const finalSellOrdersCount = await SellOrder.countDocuments({});
    const finalSowingsCount = await Sowing.countDocuments({});
    
    const finalSlotSummary = await PlantSlot.aggregate([
      {
        $unwind: "$subtypeSlots"
      },
      {
        $unwind: "$subtypeSlots.slots"
      },
      {
        $group: {
          _id: null,
          totalCapacity: { $sum: "$subtypeSlots.slots.totalPlants" },
          totalBooked: { $sum: "$subtypeSlots.slots.totalBookedPlants" },
          totalPlantsSowed: { $sum: "$subtypeSlots.slots.plantsSowed" },
          totalOfficeSowed: { $sum: "$subtypeSlots.slots.officeSowed" },
          totalPrimarySowed: { $sum: "$subtypeSlots.slots.primarySowed" }
        }
      }
    ]);
    
    const finalSlotStats = finalSlotSummary.length > 0 ? finalSlotSummary[0] : {
      totalCapacity: 0,
      totalBooked: 0,
      totalPlantsSowed: 0,
      totalOfficeSowed: 0,
      totalPrimarySowed: 0
    };
    
    console.log('📦 After Reset Summary:');
    console.log(`   Orders: ${finalOrdersCount}`);
    console.log(`   Dealer Orders: ${finalDealerOrdersCount}`);
    console.log(`   Sell Orders: ${finalSellOrdersCount}`);
    console.log(`   Sowings: ${finalSowingsCount}`);
    console.log(`   Total Orders: ${finalOrdersCount + finalDealerOrdersCount + finalSellOrdersCount}`);
    console.log(`\n   Slot Capacity: ${(finalSlotStats.totalCapacity || 0).toLocaleString()}`);
    console.log(`   Slot Booked: ${(finalSlotStats.totalBooked || 0).toLocaleString()}`);
    console.log(`   Slot Plants Sowed: ${(finalSlotStats.totalPlantsSowed || 0).toLocaleString()}`);
    console.log(`   Slot Office Sowed: ${(finalSlotStats.totalOfficeSowed || 0).toLocaleString()}`);
    console.log(`   Slot Primary Sowed: ${(finalSlotStats.totalPrimarySowed || 0).toLocaleString()}\n`);
    
    // Check if everything is clean
    const allClean = 
      finalOrdersCount === 0 &&
      finalDealerOrdersCount === 0 &&
      finalSellOrdersCount === 0 &&
      finalSowingsCount === 0 &&
      (finalSlotStats.totalCapacity || 0) === 0 &&
      (finalSlotStats.totalBooked || 0) === 0 &&
      (finalSlotStats.totalPlantsSowed || 0) === 0 &&
      (finalSlotStats.totalOfficeSowed || 0) === 0 &&
      (finalSlotStats.totalPrimarySowed || 0) === 0;
    
    if (allClean) {
      console.log('✅ SUCCESS: All orders, sowings, and slot data have been completely reset!');
      console.log('✅ Database is now clean and ready for fresh data.\n');
    } else {
      console.log('⚠️  WARNING: Some data may still exist. Please check the summary above.\n');
    }
    
    // Summary
    console.log('📊 Cleanup Summary:');
    console.log(`   ✅ Orders Deleted: ${totalOrdersDeleted}`);
    console.log(`   ✅ Sowings Deleted: ${sowingsResult.deletedCount}`);
    console.log(`   ✅ Slot Documents Updated: ${totalSlotDocsUpdated}`);
    console.log(`   ✅ Total Operations: ${totalOrdersDeleted + sowingsResult.deletedCount + totalSlotDocsUpdated}\n`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  }
};

resetOrdersSlotsSowings();



