import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import moment from 'moment';

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

const addPrimarySowingToAllSlots = async () => {
  try {
    await connectDB();
    
    const PlantCms = (await import('./models/plantCms.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    console.log('\n🌱 Adding Primary Sowing to All Slots for Papaya and Watermelon');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    // Find Papaya and Watermelon plants
    const plants = await PlantCms.find({
      name: { 
        $in: [
          /^papaya$/i, 
          /^watermelon$/i
        ]
      }
    });
    
    if (plants.length === 0) {
      console.log('❌ Papaya or Watermelon plants not found.');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`✅ Found ${plants.length} plant(s):`);
    plants.forEach(p => console.log(`   - ${p.name} (${p._id})`));
    console.log();
    
    let totalSlotsUpdated = 0;
    let totalPrimarySowedAdded = 0;
    
    // Process each plant
    for (const plant of plants) {
      console.log(`\n📦 Processing Plant: ${plant.name}`);
      console.log(`   Subtypes: ${plant.subtypes?.length || 0}`);
      
      // Find all PlantSlot documents for this plant
      const plantSlots = await PlantSlot.find({
        plantId: plant._id
      });
      
      if (plantSlots.length === 0) {
        console.log(`   ⚠️  No slots found for ${plant.name}\n`);
        continue;
      }
      
      console.log(`   📊 Found ${plantSlots.length} PlantSlot document(s) for ${plant.name}\n`);
      
      // Process each year's slots
      for (const plantSlot of plantSlots) {
        console.log(`   📅 Processing Year ${plantSlot.year}...`);
        
        // Process all subtypes
        if (!plantSlot.subtypeSlots || plantSlot.subtypeSlots.length === 0) {
          console.log(`      ⚠️  No subtype slots found for year ${plantSlot.year}\n`);
          continue;
        }
        
        let yearSlotsUpdated = 0;
        let yearPrimarySowedAdded = 0;
        
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
          
          console.log(`      🌿 Subtype: ${subtypeName} (${subtypeSlot.slots.length} slots)`);
          
          // Update ALL slots for this subtype
          for (const slot of subtypeSlot.slots) {
            // Random primary sowing: 1000 to 10000 plants
            const randomPrimarySowed = Math.floor(Math.random() * 9000) + 1000;
            
            // Calculate sowing date (1-5 days before slot start date)
            const slotDate = slot.startDay; // Format: DD-MM-YYYY
            const slotMoment = moment(slotDate, "DD-MM-YYYY");
            const daysBeforeSlot = Math.floor(Math.random() * 5) + 1;
            const sowingDateMoment = slotMoment.clone().subtract(daysBeforeSlot, 'days');
            const sowingDateStr = sowingDateMoment.format("DD-MM-YYYY");
            
            // Update the slot
            await PlantSlot.updateOne(
              { 
                _id: plantSlot._id,
                "subtypeSlots.subtypeId": subtypeSlot.subtypeId
              },
              {
                $set: {
                  "subtypeSlots.$[subtypeSlot].slots.$[slot].primarySowed": randomPrimarySowed,
                  "subtypeSlots.$[subtypeSlot].slots.$[slot].sowingDate": sowingDateStr,
                  "subtypeSlots.$[subtypeSlot].slots.$[slot].plantsSowed": randomPrimarySowed
                }
              },
              {
                arrayFilters: [
                  { "subtypeSlot.subtypeId": subtypeSlot.subtypeId },
                  { "slot._id": slot._id }
                ]
              }
            );
            
            yearSlotsUpdated++;
            yearPrimarySowedAdded += randomPrimarySowed;
            totalSlotsUpdated++;
            totalPrimarySowedAdded += randomPrimarySowed;
          }
          
          console.log(`         ✅ Updated ${subtypeSlot.slots.length} slots with primary sowing`);
        }
        
        console.log(`      📊 Year ${plantSlot.year} Summary: ${yearSlotsUpdated} slots, ${yearPrimarySowedAdded.toLocaleString()} plants\n`);
      }
    }
    
    // Final Summary
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('📊 FINAL SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Plants Processed: ${plants.map(p => p.name).join(', ')}`);
    console.log(`Total Slots Updated: ${totalSlotsUpdated}`);
    console.log(`Total Primary Sowed Added: ${totalPrimarySowedAdded.toLocaleString()} plants`);
    console.log(`Average per Slot: ${totalSlotsUpdated > 0 ? Math.round(totalPrimarySowedAdded / totalSlotsUpdated).toLocaleString() : 0} plants`);
    
    // Verify updates
    console.log('\n🔍 Verifying updates...\n');
    
    let verifyTotalSlots = 0;
    let verifyTotalPrimarySowed = 0;
    
    for (const plant of plants) {
      const verifySlots = await PlantSlot.find({
        plantId: plant._id
      });
      
      verifySlots.forEach(ps => {
        if (ps.subtypeSlots) {
          ps.subtypeSlots.forEach(subtypeSlot => {
            if (subtypeSlot.slots) {
              subtypeSlot.slots.forEach(slot => {
                if (slot.primarySowed > 0) {
                  verifyTotalSlots++;
                  verifyTotalPrimarySowed += slot.primarySowed;
                }
              });
            }
          });
        }
      });
    }
    
    console.log(`✅ Verification:`);
    console.log(`   Slots with primary sowing: ${verifyTotalSlots}`);
    console.log(`   Total primary sowed: ${verifyTotalPrimarySowed.toLocaleString()} plants`);
    
    if (verifyTotalSlots === totalSlotsUpdated && verifyTotalPrimarySowed > 0) {
      console.log('\n✅ All slots updated successfully!');
    } else {
      console.log(`\n⚠️  Verification mismatch: Expected ${totalSlotsUpdated} slots, found ${verifyTotalSlots}`);
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

addPrimarySowingToAllSlots();



