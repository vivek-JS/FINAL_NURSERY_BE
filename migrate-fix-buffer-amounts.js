/**
 * Migration Script: Fix Buffer Amounts for All Slots
 * 
 * This script recalculates bufferAmount and availablePlants for all existing slots
 * using the correct formula: availablePlants = totalPlants - totalBookedPlants - bufferAmount
 */

import mongoose from 'mongoose';
import PlantSlot from './models/slots.model.js';
import PlantCms from './models/plantCms.model.js';
import { calculateEffectiveBuffer } from './utility/bufferUtils.js';

async function migrateBufferAmounts() {
  try {
    const dotenv = await import('dotenv');
    dotenv.config();
    
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ Connected to MongoDB\n');

    const plantSlots = await PlantSlot.find().populate('plantId');
    
    if (plantSlots.length === 0) {
      console.log('❌ No plant slots found');
      process.exit(1);
    }

    console.log(`Found ${plantSlots.length} plant slot documents\n`);
    console.log('═'.repeat(100));
    console.log('🔄 Starting migration...\n');

    let totalSlotsProcessed = 0;
    let totalSlotsFixed = 0;
    let totalSlotsSkipped = 0;
    let errors = [];

    for (const plantSlot of plantSlots) {
      const plant = plantSlot.plantId;
      const plantBuffer = plant?.buffer || 0;
      
      console.log(`\n📦 Processing Plant: ${plant?.name || 'Unknown'} (Plant Buffer: ${plantBuffer}%)`);

      for (const subtypeSlot of plantSlot.subtypeSlots) {
        const subtype = plant?.subtypes?.find(s => s._id.toString() === subtypeSlot.subtypeId.toString());
        const subtypeBuffer = subtype?.buffer || 0;
        
        console.log(`   📂 Subtype: ${subtype?.name || 'Unknown'} (Subtype Buffer: ${subtypeBuffer}%)`);
        console.log(`      Processing ${subtypeSlot.slots.length} slots...`);

        for (const slot of subtypeSlot.slots) {
          totalSlotsProcessed++;

          try {
            // Calculate effective buffer
            const slotBuffer = slot.buffer || 0;
            const effectiveBuffer = calculateEffectiveBuffer(slotBuffer, subtypeBuffer, plantBuffer);
            
            // Get current values
            const totalPlants = slot.totalPlants || 0;
            const totalBookedPlants = slot.totalBookedPlants || 0;
            
            // Calculate correct buffer amount
            const bufferAmount = Math.round((totalPlants * effectiveBuffer) / 100);
            
            // Calculate correct available plants
            const availablePlants = Math.max(0, totalPlants - totalBookedPlants - bufferAmount);
            
            // Calculate buffer adjusted capacity
            const bufferAdjustedCapacity = totalPlants - bufferAmount;
            
            // Check if slot needs updating
            const needsUpdate = 
              slot.bufferAmount !== bufferAmount ||
              slot.availablePlants !== availablePlants ||
              slot.effectiveBuffer !== effectiveBuffer ||
              slot.bufferAdjustedCapacity !== bufferAdjustedCapacity;
            
            if (!needsUpdate && effectiveBuffer === 0) {
              totalSlotsSkipped++;
              continue;
            }

            // Update the slot
            await PlantSlot.updateOne(
              { _id: plantSlot._id },
              {
                $set: {
                  [`subtypeSlots.$[subtypeElem].slots.$[slotElem].effectiveBuffer`]: effectiveBuffer,
                  [`subtypeSlots.$[subtypeElem].slots.$[slotElem].bufferAmount`]: bufferAmount,
                  [`subtypeSlots.$[subtypeElem].slots.$[slotElem].availablePlants`]: availablePlants,
                  [`subtypeSlots.$[subtypeElem].slots.$[slotElem].bufferAdjustedCapacity`]: bufferAdjustedCapacity
                }
              },
              {
                arrayFilters: [
                  { 'subtypeElem.subtypeId': subtypeSlot.subtypeId },
                  { 'slotElem._id': slot._id }
                ]
              }
            );

            totalSlotsFixed++;
            
            if (totalSlotsFixed <= 10 || effectiveBuffer > 0) {
              console.log(`      ✅ Fixed Slot ${slot._id} (${slot.month} ${slot.startDay})`);
              console.log(`         effectiveBuffer: ${effectiveBuffer}%`);
              console.log(`         bufferAmount: ${slot.bufferAmount || 0} → ${bufferAmount}`);
              console.log(`         availablePlants: ${slot.availablePlants || 0} → ${availablePlants}`);
              console.log(`         Formula: ${availablePlants} + ${totalBookedPlants} + ${bufferAmount} = ${totalPlants} ✅`);
            }
          } catch (error) {
            errors.push({
              slotId: slot._id,
              month: slot.month,
              error: error.message
            });
            console.error(`      ❌ Error fixing slot ${slot._id}:`, error.message);
          }
        }
      }
      console.log(`   ✓ Completed ${plant?.name || 'Unknown'}`);
    }

    console.log('\n' + '═'.repeat(100));
    console.log('📊 MIGRATION SUMMARY:');
    console.log(`   Total slots processed: ${totalSlotsProcessed}`);
    console.log(`   Slots fixed: ${totalSlotsFixed} ✅`);
    console.log(`   Slots skipped (no buffer): ${totalSlotsSkipped}`);
    console.log(`   Errors: ${errors.length} ${errors.length > 0 ? '❌' : '✅'}`);
    
    if (errors.length > 0) {
      console.log('\n❌ Errors encountered:');
      errors.forEach((err, idx) => {
        console.log(`   ${idx + 1}. Slot ${err.slotId} (${err.month}): ${err.error}`);
      });
    }

    console.log('\n✅ Migration completed!');
    console.log('═'.repeat(100));

    await mongoose.connection.close();
    console.log('\n✅ Connection closed');
  } catch (error) {
    console.error('❌ Migration Error:', error);
    process.exit(1);
  }
}

console.log('\n');
console.log('═'.repeat(100));
console.log('          BUFFER AMOUNT MIGRATION SCRIPT');
console.log('═'.repeat(100));
console.log('\nThis script will:');
console.log('1. Calculate effectiveBuffer for each slot (slot > subtype > plant)');
console.log('2. Calculate bufferAmount based on effectiveBuffer percentage');
console.log('3. Recalculate availablePlants using the correct formula:');
console.log('   availablePlants = totalPlants - totalBookedPlants - bufferAmount');
console.log('4. Update bufferAdjustedCapacity');
console.log('\nPress Ctrl+C to cancel, or wait 3 seconds to continue...\n');

setTimeout(() => {
  migrateBufferAmounts();
}, 3000);

