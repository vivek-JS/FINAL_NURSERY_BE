import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import moment from 'moment';

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

/**
 * Generate 7-day slots for a date range
 * @param {string} startDate - Start date in DD-MM-YYYY format
 * @param {string} endDate - End date in DD-MM-YYYY format
 * @param {number} slotSize - Number of days per slot (7)
 * @param {number} availablePlantsPerSlot - Available plants per slot (100,000)
 * @param {number} plantReadyDays - Plant ready days from subtype
 * @returns {Array} Array of slot objects
 */
const generate7DaySlots = (startDate, endDate, slotSize, availablePlantsPerSlot, plantReadyDays = 0) => {
  const slots = [];
  const start = moment(startDate, 'DD-MM-YYYY');
  const end = moment(endDate, 'DD-MM-YYYY');
  
  let currentDate = start.clone();
  
  while (currentDate.isSameOrBefore(end)) {
    // Calculate slot end date (7 days from start, or end date if less than 7 days remaining)
    const slotEnd = moment.min(
      currentDate.clone().add(slotSize - 1, 'days'),
      end.clone()
    );
    
    // Format dates as DD-MM-YYYY
    const startDay = currentDate.format('DD-MM-YYYY');
    const endDay = slotEnd.format('DD-MM-YYYY');
    
    // Get month name
    const monthName = currentDate.format('MMMM');
    
    // Create slot object with 100,000 available plants per slot
    const slot = {
      startDay,
      endDay,
      month: monthName,
      totalPlants: availablePlantsPerSlot,
      totalBookedPlants: 0,
      availablePlants: availablePlantsPerSlot,
      buffer: 0,
      effectiveBuffer: 0,
      bufferAdjustedCapacity: availablePlantsPerSlot,
      bufferAmount: 0,
      originalTotalPlants: availablePlantsPerSlot,
      isOverflow: false,
      orders: [],
      allowedSalesmen: [],
      restrictToSalesmen: false,
      overflow: false,
      status: true,
      isManual: false,
      plantReadyDays,
      plantsSowed: 0,
      officeSowed: 0,
      primarySowed: 0,
      sowingDate: null,
      plantReadyDate: null,
      reminderBeforePlantReadyDays: 0,
      slotTrail: []
    };
    
    slots.push(slot);
    
    // Move to next slot start (7 days ahead)
    currentDate.add(slotSize, 'days');
  }
  
  return slots;
};

const setupBananaG9Slots = async () => {
  try {
    await connectDB();
    
    const PlantCms = (await import('./models/plantCms.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    console.log('\n🍌 Generating 7-Day Slots for Banana G9');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    // Find Banana plant
    const bananaPlant = await PlantCms.findOne({
      name: { $regex: new RegExp('^banana$', 'i') }
    });
    
    if (!bananaPlant) {
      console.log('❌ Banana plant not found in database');
      return;
    }
    
    console.log(`✅ Found plant: ${bananaPlant.name} (${bananaPlant._id})`);
    console.log(`   Total Subtypes: ${bananaPlant.subtypes?.length || 0}\n`);
    
    // Find G9 subtype
    const g9Subtype = bananaPlant.subtypes.find(sub => 
      sub.name && (sub.name.toLowerCase().includes('g-9') || sub.name.toLowerCase().includes('g9'))
    );
    
    if (!g9Subtype) {
      console.log('❌ G9 subtype not found. Available subtypes:');
      bananaPlant.subtypes.forEach((sub, idx) => {
        console.log(`   ${idx + 1}. ${sub.name} (${sub._id})`);
      });
      return;
    }
    
    console.log(`✅ Found subtype: ${g9Subtype.name} (${g9Subtype._id})`);
    console.log(`   Plant Ready Days: ${g9Subtype.plantReadyDays || 0}\n`);
    
    // Update plant slotSize to 7 if needed
    if (bananaPlant.slotSize !== 7) {
      bananaPlant.slotSize = 7;
      await bananaPlant.save();
      console.log(`✅ Updated banana slotSize to 7 days\n`);
    }
    
    // Configuration
    const SLOT_SIZE = 7; // 7-day slots
    const AVAILABLE_PLANTS_PER_SLOT = 100000; // 100,000 plants per slot
    
    console.log('📋 Configuration:');
    console.log(`   Slot Size: ${SLOT_SIZE} days`);
    console.log(`   Available Plants per Slot: ${AVAILABLE_PLANTS_PER_SLOT.toLocaleString()}`);
    console.log(`   Date Range: 01-01-2025 to 31-12-2026\n`);
    
    const years = [2025, 2026];
    
    for (const year of years) {
      console.log(`\n${'='.repeat(70)}`);
      console.log(`📅 Processing Year ${year}`);
      console.log(`${'='.repeat(70)}\n`);
      
      // Calculate date range for this year
      const yearStartDate = '01-01-2025';
      const yearEndDate = '31-12-2026';
      
      // For individual year processing
      const startDate = year === 2025 ? '01-01-2025' : '01-01-2026';
      const endDate = year === 2025 ? '31-12-2025' : '31-12-2026';
      
      console.log(`Date Range: ${startDate} to ${endDate}`);
      
      // Find or create PlantSlot document for this year
      let plantSlot = await PlantSlot.findOne({
        plantId: bananaPlant._id,
        year: year
      });
      
      if (!plantSlot) {
        // Create new PlantSlot document
        plantSlot = new PlantSlot({
          plantId: bananaPlant._id,
          year: year,
          subtypeSlots: []
        });
        console.log(`✅ Created new PlantSlot document for year ${year}`);
      } else {
        console.log(`✅ Found existing PlantSlot document for year ${year}`);
      }
      
      // Generate slots for G9 subtype
      const plantReadyDays = g9Subtype.plantReadyDays || 0;
      const slots = generate7DaySlots(
        startDate,
        endDate,
        SLOT_SIZE,
        AVAILABLE_PLANTS_PER_SLOT,
        plantReadyDays
      );
      
      console.log(`\n   🌱 ${g9Subtype.name}:`);
      console.log(`      Subtype ID: ${g9Subtype._id}`);
      console.log(`      Plant Ready Days: ${plantReadyDays}`);
      console.log(`      Slots to create: ${slots.length}`);
      console.log(`      Available Plants per Slot: ${AVAILABLE_PLANTS_PER_SLOT.toLocaleString()}`);
      
      // Check if subtypeSlots already exists for G9
      const existingSubtypeSlotIndex = plantSlot.subtypeSlots.findIndex(
        st => st.subtypeId.toString() === g9Subtype._id.toString()
      );
      
      if (existingSubtypeSlotIndex !== -1) {
        // Replace existing slots for G9
        plantSlot.subtypeSlots[existingSubtypeSlotIndex].slots = slots;
        console.log(`      ✅ Updated: Replaced with ${slots.length} slots for ${g9Subtype.name}`);
      } else {
        // Add new subtypeSlots
        plantSlot.subtypeSlots.push({
          subtypeId: g9Subtype._id,
          slots: slots
        });
        console.log(`      ✅ Added: ${slots.length} slots for ${g9Subtype.name}`);
      }
      
      // Save the PlantSlot document
      await plantSlot.save();
      console.log(`\n✅ Saved PlantSlot document for year ${year}`);
      
      // Show summary for this year
      const totalSlots = plantSlot.subtypeSlots.reduce((sum, st) => sum + st.slots.length, 0);
      const g9Slots = plantSlot.subtypeSlots.find(st => st.subtypeId.toString() === g9Subtype._id.toString());
      const g9SlotCount = g9Slots ? g9Slots.slots.length : 0;
      console.log(`   Total slots in year ${year}: ${totalSlots}`);
      console.log(`   G9 slots in year ${year}: ${g9SlotCount}`);
    }
    
    // Final Summary
    console.log('\n' + '='.repeat(70));
    console.log('📊 FINAL SUMMARY');
    console.log('='.repeat(70));
    
    const allSlots = await PlantSlot.find({ plantId: bananaPlant._id });
    
    let grandTotal = 0;
    let g9Total = 0;
    let totalCapacity = 0;
    
    for (const ps of allSlots) {
      console.log(`\nYear ${ps.year}:`);
      for (const st of ps.subtypeSlots) {
        const subtype = bananaPlant.subtypes.find(s => s._id.toString() === st.subtypeId.toString());
        const subtypeName = subtype ? subtype.name : 'Unknown';
        const slotCount = st.slots.length;
        const capacity = st.slots.reduce((sum, slot) => sum + (slot.availablePlants || 0), 0);
        
        console.log(`   ${subtypeName}: ${slotCount} slots, ${capacity.toLocaleString()} total capacity`);
        
        grandTotal += slotCount;
        if (subtype && (subtype.name.toLowerCase().includes('g-9') || subtype.name.toLowerCase().includes('g9'))) {
          g9Total += slotCount;
          totalCapacity += capacity;
        }
      }
    }
    
    console.log(`\n🎯 G9 SUMMARY:`);
    console.log(`   Total G9 Slots: ${g9Total}`);
    console.log(`   Total G9 Capacity: ${totalCapacity.toLocaleString()} plants`);
    console.log(`   Average per Slot: ${g9Total > 0 ? (totalCapacity / g9Total).toLocaleString() : 0} plants`);
    console.log(`\n✅ Slot generation completed successfully!`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

setupBananaG9Slots();
