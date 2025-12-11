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

const resetWatermelonSlots = async () => {
  try {
    await connectDB();
    
    const PlantCms = (await import('./models/plantCms.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    // Target plant: Watermelon
    const targetPlantName = 'watermelon';
    
    console.log('\n📊 Finding Watermelon plant...\n');
    
    // Find watermelon plant (case insensitive)
    const plant = await PlantCms.findOne({
      name: { $regex: new RegExp(`^${targetPlantName}$`, 'i') }
    }).select('_id name subtypes');
    
    if (!plant) {
      console.log('❌ Watermelon plant not found.');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`✅ Found plant: ${plant.name} (${plant._id})`);
    console.log(`   Subtypes: ${plant.subtypes?.length || 0}`);
    if (plant.subtypes && plant.subtypes.length > 0) {
      plant.subtypes.forEach((subtype, idx) => {
        console.log(`      ${idx + 1}. ${subtype.name} (${subtype._id})`);
      });
    }
    
    console.log('\n📊 Finding slots for Watermelon...\n');
    
    // Find all PlantSlot documents for watermelon
    const plantSlots = await PlantSlot.find({
      plantId: plant._id
    });
    
    if (plantSlots.length === 0) {
      console.log('ℹ️  No slots found for Watermelon.');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`📦 Found ${plantSlots.length} PlantSlot document(s) for Watermelon`);
    
    // Count slots and values before update
    let totalSlots = 0;
    let slotsWithData = 0;
    let verifyTotalPlants = 0;
    let totalAvailablePlants = 0;
    let totalPlantsSowed = 0;
    let totalOfficeSowed = 0;
    let totalPrimarySowed = 0;
    let totalBookedPlants = 0;
    
    plantSlots.forEach(plantSlot => {
      console.log(`\n   Year: ${plantSlot.year}`);
      plantSlot.subtypeSlots?.forEach(subtypeSlot => {
        console.log(`      Subtype: ${subtypeSlot.subtypeName || 'Unknown'}`);
        subtypeSlot.slots?.forEach(slot => {
          totalSlots++;
          const totalPlants = slot.totalPlants || 0;
          const available = slot.availablePlants || 0;
          const sowed = slot.plantsSowed || 0;
          const officeSowed = slot.officeSowed || 0;
          const primarySowed = slot.primarySowed || 0;
          const booked = slot.totalBookedPlants || 0;
          
          if (totalPlants > 0 || available > 0 || sowed > 0 || officeSowed > 0 || primarySowed > 0 || booked > 0) {
            slotsWithData++;
            verifyTotalPlants += totalPlants;
            totalAvailablePlants += available;
            totalPlantsSowed += sowed;
            totalOfficeSowed += officeSowed;
            totalPrimarySowed += primarySowed;
            totalBookedPlants += booked;
          }
        });
      });
    });
    
    console.log(`\n📊 Statistics before reset:`);
    console.log(`   - Total slots: ${totalSlots}`);
    console.log(`   - Slots with data > 0: ${slotsWithData}`);
    console.log(`   - Total totalPlants: ${verifyTotalPlants}`);
    console.log(`   - Total totalBookedPlants: ${totalBookedPlants}`);
    console.log(`   - Total availablePlants (stored): ${totalAvailablePlants}`);
    console.log(`   - Total plantsSowed: ${totalPlantsSowed}`);
    console.log(`   - Total officeSowed: ${totalOfficeSowed}`);
    console.log(`   - Total primarySowed: ${totalPrimarySowed}`);
    console.log(`   ⚠️  API calculates: availablePlants = totalPlants - totalBookedPlants`);
    console.log(`   ⚠️  API will show: availablePlants = ${verifyTotalPlants} - ${totalBookedPlants} = ${verifyTotalPlants - totalBookedPlants}`);
    
    if (slotsWithData === 0) {
      console.log('\nℹ️  No data found to reset. All values are already 0.');
      await mongoose.connection.close();
      return;
    }
    
    console.log('\n🗑️  Resetting all values to 0 for Watermelon slots...\n');
    
    // Update all slots to set values to 0
    let updatedCount = 0;
    let updatedSlots = 0;
    
    for (const plantSlot of plantSlots) {
      let hasChanges = false;
      
      if (plantSlot.subtypeSlots && Array.isArray(plantSlot.subtypeSlots)) {
        plantSlot.subtypeSlots.forEach(subtypeSlot => {
          if (subtypeSlot.slots && Array.isArray(subtypeSlot.slots)) {
            subtypeSlot.slots.forEach(slot => {
              let slotChanged = false;
              
              // Reset availablePlants to 0 (or recalculate it)
              // Note: availablePlants is calculated as totalPlants - totalBookedPlants by API
              // So we need to reset totalBookedPlants too
              
              // Reset totalBookedPlants to 0 (important for API calculation)
              if (slot.totalBookedPlants !== 0) {
                slot.totalBookedPlants = 0;
                slotChanged = true;
              }
              
              // Reset totalPlants to 0 (this will make availablePlants = 0 via API calculation)
              if (slot.totalPlants !== 0) {
                slot.totalPlants = 0;
                slotChanged = true;
              }
              
              // Reset availablePlants to 0
              if (slot.availablePlants !== 0) {
                slot.availablePlants = 0;
                slotChanged = true;
              }
              
              // Reset plantsSowed to 0
              if (slot.plantsSowed !== 0) {
                slot.plantsSowed = 0;
                slotChanged = true;
              }
              
              // Reset officeSowed to 0
              if (slot.officeSowed !== 0) {
                slot.officeSowed = 0;
                slotChanged = true;
              }
              
              // Reset primarySowed to 0
              if (slot.primarySowed !== 0) {
                slot.primarySowed = 0;
                slotChanged = true;
              }
              
              // Also clear orders array
              if (slot.orders && slot.orders.length > 0) {
                slot.orders = [];
                slotChanged = true;
              }
              
              if (slotChanged) {
                hasChanges = true;
                updatedSlots++;
              }
            });
          }
        });
      }
      
      if (hasChanges) {
        await plantSlot.save();
        updatedCount++;
        console.log(`   ✅ Updated PlantSlot document for year ${plantSlot.year}`);
      }
    }
    
    console.log(`\n✅ Updated ${updatedCount} PlantSlot document(s)`);
    console.log(`✅ Reset values for ${updatedSlots} slot(s)`);
    
    // Verify the reset
    console.log('\n🔍 Verifying reset...\n');
    const verifySlots = await PlantSlot.find({
      plantId: plant._id
    });
    
    let verifyTotalAvailable = 0;
    let verifyTotalSowed = 0;
    let verifyTotalOffice = 0;
    let verifyTotalPrimary = 0;
    let verifyTotalBooked = 0;
    let verifyTotalPlantsAfter = 0;
    
    verifySlots.forEach(plantSlot => {
      plantSlot.subtypeSlots?.forEach(subtypeSlot => {
        subtypeSlot.slots?.forEach(slot => {
          verifyTotalAvailable += slot.availablePlants || 0;
          verifyTotalSowed += slot.plantsSowed || 0;
          verifyTotalOffice += slot.officeSowed || 0;
          verifyTotalPrimary += slot.primarySowed || 0;
          verifyTotalBooked += slot.totalBookedPlants || 0;
          verifyTotalPlantsAfter += slot.totalPlants || 0;
        });
      });
    });
    
    console.log(`📊 Statistics after reset:`);
    console.log(`   - Total totalPlants: ${verifyTotalPlantsAfter}`);
    console.log(`   - Total totalBookedPlants: ${verifyTotalBooked} (should be 0 for API to show correct available)`);
    console.log(`   - Total availablePlants: ${verifyTotalAvailable}`);
    console.log(`   - Total plantsSowed: ${verifyTotalSowed}`);
    console.log(`   - Total officeSowed: ${verifyTotalOffice}`);
    console.log(`   - Total primarySowed: ${verifyTotalPrimary}`);
    
    // Calculate expected available based on API logic: totalPlants - totalBookedPlants
    const expectedAvailableFromAPI = verifyTotalPlantsAfter - verifyTotalBooked;
    console.log(`\n💡 API Calculation:`);
    console.log(`   availablePlants = totalPlants - totalBookedPlants`);
    console.log(`   availablePlants = ${verifyTotalPlantsAfter} - ${verifyTotalBooked} = ${expectedAvailableFromAPI}`);
    
    if (verifyTotalPlantsAfter === 0 && verifyTotalBooked === 0 && verifyTotalSowed === 0 && verifyTotalOffice === 0 && verifyTotalPrimary === 0) {
      console.log('\n✅ SUCCESS! All values reset to 0 for Watermelon and its subtypes!');
      console.log(`   API will now show availablePlants = 0 (totalPlants - totalBookedPlants = 0 - 0)`);
    } else if (verifyTotalBooked === 0 && verifyTotalSowed === 0 && verifyTotalOffice === 0 && verifyTotalPrimary === 0) {
      console.log('\n✅ SUCCESS! All sowed/booked values reset to 0!');
      console.log(`   API will show availablePlants = ${verifyTotalPlantsAfter} (totalPlants - 0 = ${verifyTotalPlantsAfter})`);
      console.log(`   💡 To make availablePlants = 0, totalPlants must also be 0`);
    } else {
      console.log('\n⚠️  WARNING: Some values are still not 0. Please check manually.');
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

resetWatermelonSlots();

