/**
 * Comprehensive Buffer Plants Fix Migration Script
 * 
 * This script:
 * 1. Recalculates totalBookedPlants from actual orders (not from stored values)
 * 2. Calculates effectiveBuffer using cascading logic (slot > subtype > plant)
 * 3. Recalculates bufferAmount based on effectiveBuffer percentage
 * 4. Recalculates availablePlants using correct formula
 * 5. Updates bufferAdjustedCapacity
 * 6. Validates data integrity
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import PlantSlot from './models/slots.model.js';
import PlantCms from './models/plantCms.model.js';
import Order from './models/order.model.js';
import { calculateEffectiveBuffer } from './utility/bufferUtils.js';

dotenv.config();

async function fixBufferPlants() {
  try {
    console.log('🔄 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ Connected to MongoDB\n');

    // First, get all orders to calculate actual booked plants
    console.log('📊 Analyzing orders to calculate actual booked plants...');
    const activeOrders = await Order.find({
      orderStatus: { 
        $nin: ['CANCELLED', 'REJECTED'] 
      }
    }).select('bookingSlot numberOfPlants remainingPlants');
    
    console.log(`Found ${activeOrders.length} active orders\n`);

    // Create a map of slot bookings
    const slotBookings = new Map();
    for (const order of activeOrders) {
      const slotId = order.bookingSlot?.toString();
      if (slotId) {
        const currentBooked = slotBookings.get(slotId) || 0;
        // Use remainingPlants if available, otherwise numberOfPlants
        const plantsToCount = order.remainingPlants !== undefined ? order.remainingPlants : order.numberOfPlants;
        slotBookings.set(slotId, currentBooked + plantsToCount);
      }
    }

    console.log(`Calculated bookings for ${slotBookings.size} unique slots\n`);

    const plantSlots = await PlantSlot.find().populate('plantId');
    
    if (plantSlots.length === 0) {
      console.log('❌ No plant slots found');
      await mongoose.connection.close();
      return;
    }

    console.log(`Found ${plantSlots.length} plant slot documents\n`);
    console.log('═'.repeat(100));
    console.log('🔄 Starting comprehensive buffer fix migration...\n');

    let totalSlotsProcessed = 0;
    let totalSlotsFixed = 0;
    let totalSlotsWithBookingMismatch = 0;
    let totalSlotsWithBufferIssues = 0;
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
            // Get actual booked plants from orders
            const slotId = slot._id.toString();
            const actualBookedPlants = slotBookings.get(slotId) || 0;
            const storedBookedPlants = slot.totalBookedPlants || 0;
            
            // Calculate effective buffer (cascading: slot > subtype > plant)
            const slotBuffer = slot.buffer || 0;
            const effectiveBuffer = calculateEffectiveBuffer(slotBuffer, subtypeBuffer, plantBuffer);
            
            // Get current values
            const totalPlants = slot.totalPlants || 0;
            
            // Calculate correct buffer amount
            const bufferAmount = Math.round((totalPlants * effectiveBuffer) / 100);
            
            // Calculate correct available plants using ACTUAL booked plants
            const correctAvailablePlants = Math.max(0, totalPlants - actualBookedPlants - bufferAmount);
            
            // Calculate buffer adjusted capacity
            const bufferAdjustedCapacity = totalPlants - bufferAmount;
            
            // Store original total plants if not already set
            const originalTotalPlants = slot.originalTotalPlants || totalPlants;

            // Check for mismatches
            const hasBookingMismatch = storedBookedPlants !== actualBookedPlants;
            const hasBufferIssue = 
              slot.bufferAmount !== bufferAmount ||
              slot.effectiveBuffer !== effectiveBuffer ||
              slot.bufferAdjustedCapacity !== bufferAdjustedCapacity;
            const hasAvailablePlantIssue = slot.availablePlants !== correctAvailablePlants;
            
            const needsUpdate = hasBookingMismatch || hasBufferIssue || hasAvailablePlantIssue;

            if (hasBookingMismatch) {
              totalSlotsWithBookingMismatch++;
            }
            if (hasBufferIssue) {
              totalSlotsWithBufferIssues++;
            }
            
            if (!needsUpdate) {
              continue;
            }

            // Update the slot with all corrections
            const updateResult = await PlantSlot.updateOne(
              { 
                _id: plantSlot._id,
                'subtypeSlots.subtypeId': subtypeSlot.subtypeId
              },
              {
                $set: {
                  'subtypeSlots.$[subtypeElem].slots.$[slotElem].effectiveBuffer': effectiveBuffer,
                  'subtypeSlots.$[subtypeElem].slots.$[slotElem].bufferAmount': bufferAmount,
                  'subtypeSlots.$[subtypeElem].slots.$[slotElem].totalBookedPlants': actualBookedPlants,
                  'subtypeSlots.$[subtypeElem].slots.$[slotElem].availablePlants': correctAvailablePlants,
                  'subtypeSlots.$[subtypeElem].slots.$[slotElem].bufferAdjustedCapacity': bufferAdjustedCapacity,
                  'subtypeSlots.$[subtypeElem].slots.$[slotElem].originalTotalPlants': originalTotalPlants,
                  'subtypeSlots.$[subtypeElem].slots.$[slotElem].isOverflow': correctAvailablePlants < 0,
                  'subtypeSlots.$[subtypeElem].slots.$[slotElem].overflow': correctAvailablePlants < 0
                }
              },
              {
                arrayFilters: [
                  { 'subtypeElem.subtypeId': subtypeSlot.subtypeId },
                  { 'slotElem._id': slot._id }
                ]
              }
            );

            if (updateResult.modifiedCount > 0) {
              totalSlotsFixed++;
              
              // Log details for problematic slots or first 10 fixes
              if (totalSlotsFixed <= 10 || hasBookingMismatch || hasBufferIssue || effectiveBuffer > 0) {
                console.log(`      ✅ Fixed Slot: ${slot.month} ${slot.startDay}-${slot.endDay}`);
                
                if (hasBookingMismatch) {
                  console.log(`         📊 Booked Plants: ${storedBookedPlants} → ${actualBookedPlants} (from orders)`);
                }
                
                if (hasBufferIssue || effectiveBuffer > 0) {
                  console.log(`         🛡️  Effective Buffer: ${slot.effectiveBuffer || 0}% → ${effectiveBuffer}%`);
                  console.log(`         🛡️  Buffer Amount: ${slot.bufferAmount || 0} → ${bufferAmount} plants`);
                  console.log(`         📦 Buffer Adjusted Capacity: ${slot.bufferAdjustedCapacity || 0} → ${bufferAdjustedCapacity}`);
                }
                
                if (hasAvailablePlantIssue) {
                  console.log(`         ✨ Available Plants: ${slot.availablePlants || 0} → ${correctAvailablePlants}`);
                }
                
                console.log(`         ✓ Formula: ${totalPlants} - ${actualBookedPlants} - ${bufferAmount} = ${correctAvailablePlants}`);
                
                if (correctAvailablePlants < 0) {
                  console.log(`         ⚠️  OVERFLOW: ${Math.abs(correctAvailablePlants)} plants over capacity!`);
                }
              }
            }
          } catch (error) {
            errors.push({
              slotId: slot._id,
              month: slot.month,
              dateRange: `${slot.startDay}-${slot.endDay}`,
              error: error.message
            });
            console.error(`      ❌ Error fixing slot ${slot._id}:`, error.message);
          }
        }
      }
      console.log(`   ✓ Completed ${plant?.name || 'Unknown'}`);
    }

    console.log('\n' + '═'.repeat(100));
    console.log('📊 COMPREHENSIVE MIGRATION SUMMARY:');
    console.log('═'.repeat(100));
    console.log(`   Total slots processed:           ${totalSlotsProcessed}`);
    console.log(`   Slots fixed:                     ${totalSlotsFixed} ✅`);
    console.log(`   Slots with booking mismatch:     ${totalSlotsWithBookingMismatch} ${totalSlotsWithBookingMismatch > 0 ? '⚠️' : '✅'}`);
    console.log(`   Slots with buffer issues:        ${totalSlotsWithBufferIssues} ${totalSlotsWithBufferIssues > 0 ? '⚠️' : '✅'}`);
    console.log(`   Errors encountered:              ${errors.length} ${errors.length > 0 ? '❌' : '✅'}`);
    
    if (errors.length > 0) {
      console.log('\n❌ Errors encountered:');
      errors.forEach((err, idx) => {
        console.log(`   ${idx + 1}. Slot ${err.slotId} (${err.month} ${err.dateRange}): ${err.error}`);
      });
    }

    // Verification
    console.log('\n🔍 Running verification...');
    const updatedPlantSlots = await PlantSlot.find();
    let totalAvailable = 0;
    let totalBooked = 0;
    let totalBuffer = 0;
    let totalCapacity = 0;
    let overflowSlots = 0;

    for (const plantSlot of updatedPlantSlots) {
      for (const subtypeSlot of plantSlot.subtypeSlots) {
        for (const slot of subtypeSlot.slots) {
          totalCapacity += slot.totalPlants || 0;
          totalBooked += slot.totalBookedPlants || 0;
          totalBuffer += slot.bufferAmount || 0;
          totalAvailable += slot.availablePlants || 0;
          if (slot.isOverflow || slot.overflow) {
            overflowSlots++;
          }
        }
      }
    }

    console.log('\n📊 System-wide Statistics:');
    console.log(`   Total Capacity:      ${totalCapacity.toLocaleString()} plants`);
    console.log(`   Total Booked:        ${totalBooked.toLocaleString()} plants`);
    console.log(`   Total Buffer:        ${totalBuffer.toLocaleString()} plants`);
    console.log(`   Total Available:     ${totalAvailable.toLocaleString()} plants`);
    console.log(`   Overflow Slots:      ${overflowSlots} ${overflowSlots > 0 ? '⚠️' : '✅'}`);
    console.log(`   Formula Check:       ${totalCapacity} - ${totalBooked} - ${totalBuffer} = ${totalAvailable}`);
    
    const calculatedAvailable = totalCapacity - totalBooked - totalBuffer;
    if (calculatedAvailable === totalAvailable) {
      console.log(`   ✅ Formula verified: All calculations are correct!`);
    } else {
      console.log(`   ⚠️  Formula mismatch: Expected ${calculatedAvailable}, got ${totalAvailable}`);
    }

    console.log('\n✅ Comprehensive buffer plants migration completed!');
    console.log('═'.repeat(100));

    await mongoose.connection.close();
    console.log('\n✅ Connection closed');
  } catch (error) {
    console.error('❌ Migration Error:', error);
    console.error('Stack trace:', error.stack);
    await mongoose.connection.close();
    process.exit(1);
  }
}

console.log('\n');
console.log('═'.repeat(100));
console.log('     COMPREHENSIVE BUFFER PLANTS FIX MIGRATION SCRIPT');
console.log('═'.repeat(100));
console.log('\nThis script will:');
console.log('1. ✅ Calculate actual booked plants from orders (not stored values)');
console.log('2. ✅ Calculate effectiveBuffer using cascading logic (slot > subtype > plant)');
console.log('3. ✅ Recalculate bufferAmount based on effectiveBuffer percentage');
console.log('4. ✅ Recalculate availablePlants using the formula:');
console.log('      availablePlants = totalPlants - actualBookedPlants - bufferAmount');
console.log('5. ✅ Update bufferAdjustedCapacity');
console.log('6. ✅ Fix booking mismatches between stored and actual values');
console.log('7. ✅ Validate all calculations with system-wide statistics');
console.log('\n⏳ Starting in 3 seconds... (Press Ctrl+C to cancel)\n');

setTimeout(() => {
  fixBufferPlants();
}, 3000);

