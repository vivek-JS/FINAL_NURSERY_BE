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
 * @param {number} totalPlantsPerDay - Plants per day (30,000)
 * @param {number} plantReadyDays - Plant ready days from subtype
 * @returns {Array} Array of slot objects
 */
const generate7DaySlots = (startDate, endDate, slotSize, totalPlantsPerDay, plantReadyDays = 0) => {
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
    
    // Calculate total plants for this slot
    // If slot is less than 7 days, calculate proportionally
    const daysInSlot = slotEnd.diff(currentDate, 'days') + 1;
    const totalPlants = totalPlantsPerDay * daysInSlot;
    
    // Create slot object
    const slot = {
      startDay,
      endDay,
      month: monthName,
      totalPlants,
      totalBookedPlants: 0,
      availablePlants: totalPlants, // Initially equals totalPlants
      buffer: 0,
      effectiveBuffer: 0,
      bufferAdjustedCapacity: totalPlants,
      bufferAmount: 0,
      originalTotalPlants: totalPlants,
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
      reminderBeforePlantReadyDays: 0
    };
    
    slots.push(slot);
    
    // Move to next slot start (7 days ahead)
    currentDate.add(slotSize, 'days');
  }
  
  return slots;
};

const createBananaSlots = async () => {
  try {
    await connectDB();
    
    const PlantCms = (await import('./models/plantCms.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    console.log('\n🍌 Creating Banana Slots for 2025 and 2026');
    console.log('═══════════════════════════════════════════════\n');
    
    // Find Banana plant
    const banana = await PlantCms.findOne({
      name: { $regex: new RegExp('^banana$', 'i') }
    });
    
    if (!banana) {
      console.log('❌ Banana plant not found');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`✅ Found Banana: ${banana.name} (${banana._id})`);
    console.log(`   Current Slot Size: ${banana.slotSize || 'Not set'}`);
    console.log(`   Subtypes: ${banana.subtypes?.length || 0}\n`);
    
    if (!banana.subtypes || banana.subtypes.length === 0) {
      console.log('❌ No subtypes found for Banana');
      await mongoose.connection.close();
      return;
    }
    
    // Configuration
    const SLOT_SIZE = 7; // 7-day slots
    const PLANTS_PER_DAY = 30000; // 30,000 plants per day
    const TOTAL_PLANTS_PER_SLOT = PLANTS_PER_DAY * SLOT_SIZE; // 210,000 per 7-day slot
    
    console.log('📋 Configuration:');
    console.log(`   Slot Size: ${SLOT_SIZE} days`);
    console.log(`   Plants per Day: ${PLANTS_PER_DAY.toLocaleString()}`);
    console.log(`   Total Plants per Slot: ${TOTAL_PLANTS_PER_SLOT.toLocaleString()}`);
    console.log(`   Years: 2025, 2026\n`);
    
    // Delete existing slots for Banana (if any)
    const existingSlots = await PlantSlot.find({ plantId: banana._id });
    if (existingSlots.length > 0) {
      console.log(`🗑️  Deleting ${existingSlots.length} existing PlantSlot document(s) for Banana...`);
      await PlantSlot.deleteMany({ plantId: banana._id });
      console.log('✅ Existing slots deleted\n');
    }
    
    // Process each year
    const years = [2025, 2026];
    let totalSlotsCreated = 0;
    
    for (const year of years) {
      console.log(`\n📅 Processing Year ${year}...`);
      console.log('─────────────────────────────────────────────');
      
      const startDate = `01-01-${year}`;
      const endDate = `31-12-${year}`;
      
      console.log(`   Date Range: ${startDate} to ${endDate}`);
      
      // Create subtypeSlots array
      const subtypeSlots = [];
      
      // Process each subtype
      for (const subtype of banana.subtypes) {
        console.log(`\n   🌿 Processing Subtype: ${subtype.name} (${subtype._id})`);
        
        const plantReadyDays = subtype.plantReadyDays || 0;
        console.log(`      Plant Ready Days: ${plantReadyDays}`);
        
        // Generate slots for this subtype
        const slots = generate7DaySlots(
          startDate,
          endDate,
          SLOT_SIZE,
          PLANTS_PER_DAY,
          plantReadyDays
        );
        
        console.log(`      Generated ${slots.length} slots`);
        
        // Calculate total capacity
        const totalCapacity = slots.reduce((sum, slot) => sum + slot.totalPlants, 0);
        console.log(`      Total Capacity: ${totalCapacity.toLocaleString()} plants`);
        
        // Add to subtypeSlots
        subtypeSlots.push({
          subtypeId: subtype._id,
          slots: slots
        });
        
        totalSlotsCreated += slots.length;
      }
      
      // Create PlantSlot document for this year
      const plantSlot = new PlantSlot({
        plantId: banana._id,
        year: year,
        subtypeSlots: subtypeSlots
      });
      
      await plantSlot.save();
      console.log(`\n   ✅ Created PlantSlot document for year ${year}`);
      console.log(`      Total slots: ${subtypeSlots.reduce((sum, st) => sum + st.slots.length, 0)}`);
    }
    
    // Update Banana's slotSize to 7 if it's different
    if (banana.slotSize !== SLOT_SIZE) {
      banana.slotSize = SLOT_SIZE;
      await banana.save();
      console.log(`\n✅ Updated Banana slotSize from ${banana.slotSize || 'N/A'} to ${SLOT_SIZE}`);
    }
    
    // Summary
    console.log('\n═══════════════════════════════════════════════');
    console.log('📊 CREATION SUMMARY');
    console.log('═══════════════════════════════════════════════');
    console.log(`Plant: ${banana.name}`);
    console.log(`Years: 2025, 2026`);
    console.log(`Subtypes: ${banana.subtypes.length}`);
    console.log(`Total Slots Created: ${totalSlotsCreated}`);
    console.log(`Slot Size: ${SLOT_SIZE} days`);
    console.log(`Plants per Day: ${PLANTS_PER_DAY.toLocaleString()}`);
    console.log(`Plants per Slot: ${TOTAL_PLANTS_PER_SLOT.toLocaleString()}`);
    console.log(`Total Capacity: ${(totalSlotsCreated * TOTAL_PLANTS_PER_SLOT).toLocaleString()} plants`);
    
    // Verify creation
    console.log('\n🔍 Verifying creation...');
    const verifySlots = await PlantSlot.find({ plantId: banana._id });
    console.log(`   Found ${verifySlots.length} PlantSlot document(s)`);
    
    verifySlots.forEach(ps => {
      const totalSlots = ps.subtypeSlots.reduce((sum, st) => sum + st.slots.length, 0);
      console.log(`   Year ${ps.year}: ${totalSlots} slots across ${ps.subtypeSlots.length} subtypes`);
    });
    
    console.log('\n✅ Banana slots creation completed successfully!');
    
  } catch (error) {
    console.error('❌ Error creating slots:', error);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

createBananaSlots();





