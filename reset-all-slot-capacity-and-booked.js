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

const resetAllSlotCapacityAndBooked = async () => {
  try {
    await connectDB();
    
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    console.log('\n📊 Counting slots before reset...\n');
    
    // Count slots with capacity or booked plants
    const slotsWithCapacity = await PlantSlot.aggregate([
      {
        $unwind: "$subtypeSlots"
      },
      {
        $unwind: "$subtypeSlots.slots"
      },
      {
        $match: {
          $or: [
            { "subtypeSlots.slots.totalPlants": { $gt: 0 } },
            { "subtypeSlots.slots.totalBookedPlants": { $gt: 0 } },
            { "subtypeSlots.slots.plantsSowed": { $gt: 0 } },
            { "subtypeSlots.slots.officeSowed": { $gt: 0 } },
            { "subtypeSlots.slots.primarySowed": { $gt: 0 } }
          ]
        }
      },
      {
        $count: "total"
      }
    ]);
    
    const totalSlotsToReset = slotsWithCapacity.length > 0 ? slotsWithCapacity[0].total : 0;
    
    // Get summary before reset
    const summaryBefore = await PlantSlot.aggregate([
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
          slotsWithCapacity: {
            $sum: {
              $cond: [{ $gt: ["$subtypeSlots.slots.totalPlants", 0] }, 1, 0]
            }
          },
          slotsWithBooked: {
            $sum: {
              $cond: [{ $gt: ["$subtypeSlots.slots.totalBookedPlants", 0] }, 1, 0]
            }
          }
        }
      }
    ]);
    
    const beforeStats = summaryBefore.length > 0 ? summaryBefore[0] : {
      totalCapacity: 0,
      totalBooked: 0,
      totalPlantsSowed: 0,
      totalOfficeSowed: 0,
      totalPrimarySowed: 0,
      slotsWithCapacity: 0,
      slotsWithBooked: 0,
      slotsWithSowed: 0
    };
    
    console.log('📦 Before Reset:');
    console.log(`   Total Capacity: ${(beforeStats.totalCapacity || 0).toLocaleString()}`);
    console.log(`   Total Stored Booked: ${(beforeStats.totalBooked || 0).toLocaleString()}`);
    console.log(`   Total Plants Sowed: ${(beforeStats.totalPlantsSowed || 0).toLocaleString()}`);
    console.log(`   Total Office Sowed: ${(beforeStats.totalOfficeSowed || 0).toLocaleString()}`);
    console.log(`   Total Primary Sowed: ${(beforeStats.totalPrimarySowed || 0).toLocaleString()}`);
    console.log(`   Slots with Capacity: ${beforeStats.slotsWithCapacity || 0}`);
    console.log(`   Slots with Booked: ${beforeStats.slotsWithBooked || 0}`);
    console.log(`   Slots with Sowed: ${beforeStats.slotsWithSowed || 0}`);
    console.log(`   Total Slots to Reset: ${totalSlotsToReset}\n`);
    
    if (totalSlotsToReset === 0) {
      console.log('ℹ️  No slots need resetting. All values are already 0.');
      await mongoose.connection.close();
      return;
    }
    
    console.log('🔄 Resetting all slot capacity, booked plants, and sowed plants to 0...\n');
    
    // Reset all slots - need to update nested arrays
    const allSlots = await PlantSlot.find({}).lean();
    let totalUpdated = 0;
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
              primarySowed: 0
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
        totalUpdated++;
      }
    }
    
    console.log(`✅ Updated ${totalUpdated} slot documents`);
    console.log(`✅ Reset Capacity: ${totalCapacityReset.toLocaleString()} plants`);
    console.log(`✅ Reset Stored Booked: ${totalBookedReset.toLocaleString()} plants`);
    console.log(`✅ Reset Plants Sowed: ${totalPlantsSowedReset.toLocaleString()} plants`);
    console.log(`✅ Reset Office Sowed: ${totalOfficeSowedReset.toLocaleString()} plants`);
    console.log(`✅ Reset Primary Sowed: ${totalPrimarySowedReset.toLocaleString()} plants`);
    
    // Verify reset
    console.log('\n🔍 Verifying reset...\n');
    
    const summaryAfter = await PlantSlot.aggregate([
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
    
    const afterStats = summaryAfter.length > 0 ? summaryAfter[0] : {
      totalCapacity: 0,
      totalBooked: 0,
      totalPlantsSowed: 0,
      totalOfficeSowed: 0,
      totalPrimarySowed: 0,
      slotsWithCapacity: 0,
      slotsWithBooked: 0,
      slotsWithSowed: 0
    };
    
    console.log('📦 After Reset:');
    console.log(`   Total Capacity: ${(afterStats.totalCapacity || 0).toLocaleString()}`);
    console.log(`   Total Stored Booked: ${(afterStats.totalBooked || 0).toLocaleString()}`);
    console.log(`   Total Plants Sowed: ${(afterStats.totalPlantsSowed || 0).toLocaleString()}`);
    console.log(`   Total Office Sowed: ${(afterStats.totalOfficeSowed || 0).toLocaleString()}`);
    console.log(`   Total Primary Sowed: ${(afterStats.totalPrimarySowed || 0).toLocaleString()}`);
    console.log(`   Slots with Capacity: ${afterStats.slotsWithCapacity || 0}`);
    console.log(`   Slots with Booked: ${afterStats.slotsWithBooked || 0}`);
    console.log(`   Slots with Sowed: ${afterStats.slotsWithSowed || 0}`);
    
    if ((afterStats.totalCapacity || 0) === 0 && 
        (afterStats.totalBooked || 0) === 0 && 
        (afterStats.totalPlantsSowed || 0) === 0 && 
        (afterStats.totalOfficeSowed || 0) === 0 && 
        (afterStats.totalPrimarySowed || 0) === 0) {
      console.log('\n✅ Verification successful: All capacity, booked, and sowed values reset to 0!');
    } else {
      console.log('\n⚠️  Warning: Some values may still be non-zero');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

resetAllSlotCapacityAndBooked();

