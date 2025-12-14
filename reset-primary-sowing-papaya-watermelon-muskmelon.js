import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
      throw new Error('MONGO_URL, MONGODB_URI or MONGO_URI environment variable is required.');
    }
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
};

const resetPrimarySowingAndTotalPlants = async () => {
  try {
    await connectDB();
    
    const PlantCms = (await import('./models/plantCms.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    console.log('\n🔄 Resetting Primary Sowing and Total Plants for Papaya, Watermelon, and Muskmelon');
    console.log('═══════════════════════════════════════════════════════════════\n');
    console.log('⚠️  This will reset primarySowed and totalPlants to 0');
    console.log('✅ totalBookedPlants will be kept unchanged\n');
    
    // Find Papaya, Watermelon, and Muskmelon plants
    const plants = await PlantCms.find({
      name: { 
        $in: [
          /^papaya$/i, 
          /^watermelon$/i,
          /^muskmelon$/i
        ]
      }
    });
    
    if (plants.length === 0) {
      console.log('❌ No plants found (Papaya, Watermelon, or Muskmelon).');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`✅ Found ${plants.length} plant(s):`);
    plants.forEach(p => console.log(`   - ${p.name} (${p._id})`));
    console.log();
    
    let totalSlotsReset = 0;
    
    // Process each plant
    for (const plant of plants) {
      console.log(`\n📦 Processing Plant: ${plant.name}`);
      
      // Find all PlantSlot documents for this plant
      const plantSlots = await PlantSlot.find({
        plantId: plant._id
      });
      
      if (plantSlots.length === 0) {
        console.log(`   ⚠️  No slots found for ${plant.name}\n`);
        continue;
      }
      
      console.log(`   📊 Found ${plantSlots.length} PlantSlot document(s)\n`);
      
      // Process each year's slots
      for (const plantSlot of plantSlots) {
        console.log(`   📅 Processing Year ${plantSlot.year}...`);
        
        if (!plantSlot.subtypeSlots || plantSlot.subtypeSlots.length === 0) {
          console.log(`      ⚠️  No subtype slots found for year ${plantSlot.year}\n`);
          continue;
        }
        
        let yearSlotsReset = 0;
        
        // Process each subtype
        for (const subtypeSlot of plantSlot.subtypeSlots) {
          if (!subtypeSlot.slots || subtypeSlot.slots.length === 0) {
            continue;
          }
          
          // Find subtype name
          const subtype = plant.subtypes?.find(
            st => st._id.toString() === subtypeSlot.subtypeId.toString()
          );
          const subtypeName = subtype?.name || 'Unknown';
          
          // Reset ALL slots for this subtype
          for (const slot of subtypeSlot.slots) {
            // Reset primarySowed, totalPlants, plantsSowed, officeSowed, availablePlants
            // Keep totalBookedPlants unchanged
            await PlantSlot.updateOne(
              { 
                _id: plantSlot._id,
                "subtypeSlots.subtypeId": subtypeSlot.subtypeId
              },
              {
                $set: {
                  "subtypeSlots.$[subtypeSlot].slots.$[slot].primarySowed": 0,
                  "subtypeSlots.$[subtypeSlot].slots.$[slot].totalPlants": 0,
                  "subtypeSlots.$[subtypeSlot].slots.$[slot].plantsSowed": 0,
                  "subtypeSlots.$[subtypeSlot].slots.$[slot].officeSowed": 0,
                  "subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants": 0,
                  "subtypeSlots.$[subtypeSlot].slots.$[slot].sowingDate": null
                }
              },
              {
                arrayFilters: [
                  { "subtypeSlot.subtypeId": subtypeSlot.subtypeId },
                  { "slot._id": slot._id }
                ]
              }
            );
            
            yearSlotsReset++;
            totalSlotsReset++;
          }
          
          console.log(`      ✅ Reset ${subtypeSlot.slots.length} slots for subtype: ${subtypeName}`);
        }
        
        console.log(`      📊 Year ${plantSlot.year}: Reset ${yearSlotsReset} slots\n`);
      }
    }
    
    // Final Summary
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('📊 FINAL SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Plants Processed: ${plants.map(p => p.name).join(', ')}`);
    console.log(`Total Slots Reset: ${totalSlotsReset}`);
    console.log(`\n✅ Reset complete!`);
    console.log(`   - primarySowed: 0`);
    console.log(`   - totalPlants: 0`);
    console.log(`   - plantsSowed: 0`);
    console.log(`   - officeSowed: 0`);
    console.log(`   - availablePlants: 0`);
    console.log(`   - sowingDate: null`);
    console.log(`\n✅ totalBookedPlants: Kept unchanged`);
    
    // Verify updates
    console.log('\n🔍 Verifying updates...\n');
    
    let verifyTotalSlots = 0;
    let slotsWithPrimarySowed = 0;
    let slotsWithTotalPlants = 0;
    
    for (const plant of plants) {
      const verifySlots = await PlantSlot.find({
        plantId: plant._id
      });
      
      verifySlots.forEach(ps => {
        if (ps.subtypeSlots) {
          ps.subtypeSlots.forEach(subtypeSlot => {
            if (subtypeSlot.slots) {
              subtypeSlot.slots.forEach(slot => {
                verifyTotalSlots++;
                if (slot.primarySowed > 0) {
                  slotsWithPrimarySowed++;
                }
                if (slot.totalPlants > 0) {
                  slotsWithTotalPlants++;
                }
              });
            }
          });
        }
      });
    }
    
    console.log(`✅ Verification:`);
    console.log(`   Total slots checked: ${verifyTotalSlots}`);
    console.log(`   Slots with primarySowed > 0: ${slotsWithPrimarySowed}`);
    console.log(`   Slots with totalPlants > 0: ${slotsWithTotalPlants}`);
    
    if (slotsWithPrimarySowed === 0 && slotsWithTotalPlants === 0) {
      console.log('\n✅ All values reset successfully!');
    } else {
      console.log(`\n⚠️  Some slots still have values: primarySowed (${slotsWithPrimarySowed}), totalPlants (${slotsWithTotalPlants})`);
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

resetPrimarySowingAndTotalPlants();





