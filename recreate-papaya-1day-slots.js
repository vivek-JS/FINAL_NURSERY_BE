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
 * Generate 1-day slots for a date range
 */
const generate1DaySlots = (startDate, endDate, plantReadyDays = 0) => {
  const slots = [];
  const start = moment(startDate, 'DD-MM-YYYY');
  const end = moment(endDate, 'DD-MM-YYYY');
  
  let currentDate = start.clone();
  
  while (currentDate.isSameOrBefore(end)) {
    const startDay = currentDate.format('DD-MM-YYYY');
    const endDay = currentDate.format('DD-MM-YYYY'); // Same day for 1-day slot
    const monthName = currentDate.format('MMMM');
    
    const slot = {
      startDay,
      endDay,
      month: monthName,
      totalPlants: 0,
      totalBookedPlants: 0,
      availablePlants: 0,
      buffer: 0,
      effectiveBuffer: 0,
      bufferAdjustedCapacity: 0,
      bufferAmount: 0,
      originalTotalPlants: 0,
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
    currentDate.add(1, 'days'); // Move to next day
  }
  
  return slots;
};

const recreatePapayaSlots = async () => {
  try {
    await connectDB();
    
    const PlantCms = (await import('./models/plantCms.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    console.log('\n🥭 Recreating Papaya Slots as 1-Day Slots');
    console.log('═══════════════════════════════════════════════\n');
    
    // Find Papaya plant
    const papaya = await PlantCms.findOne({
      name: { $regex: new RegExp('^papaya$', 'i') }
    });
    
    if (!papaya) {
      console.log('❌ Papaya plant not found.');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`✅ Found plant: ${papaya.name} (${papaya._id})`);
    console.log(`   Current Slot Size: ${papaya.slotSize || 'Not set'}`);
    console.log(`   Subtypes: ${papaya.subtypes?.length || 0}`);
    if (papaya.subtypes && papaya.subtypes.length > 0) {
      papaya.subtypes.forEach((subtype, idx) => {
        console.log(`      ${idx + 1}. ${subtype.name} (${subtype._id})`);
      });
    }
    
    // Delete existing slots
    console.log('\n🗑️  Deleting existing Papaya slots...');
    const existingSlots = await PlantSlot.find({ plantId: papaya._id });
    if (existingSlots.length > 0) {
      const deleteResult = await PlantSlot.deleteMany({ plantId: papaya._id });
      console.log(`✅ Deleted ${deleteResult.deletedCount} PlantSlot document(s)`);
    } else {
      console.log('ℹ️  No existing slots found');
    }
    
    // Update plant slotSize to 1
    if (papaya.slotSize !== 1) {
      papaya.slotSize = 1;
      await papaya.save();
      console.log(`✅ Updated Papaya slotSize to 1 day`);
    }
    
    // Configuration
    const SLOT_SIZE = 1; // 1-day slots
    
    console.log(`\n📋 Configuration:`);
    console.log(`   Slot Size: ${SLOT_SIZE} day`);
    console.log(`   Total Plants: 0`);
    console.log(`   Available Plants: 0`);
    console.log(`   Years: 2025, 2026\n`);
    
    // Create slots for each year
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
      for (const subtype of papaya.subtypes) {
        console.log(`\n   🌿 Processing Subtype: ${subtype.name} (${subtype._id})`);
        
        const plantReadyDays = subtype.plantReadyDays || 0;
        console.log(`      Plant Ready Days: ${plantReadyDays}`);
        
        // Generate 1-day slots for this subtype
        const slots = generate1DaySlots(
          startDate,
          endDate,
          plantReadyDays
        );
        
        console.log(`      Generated ${slots.length} slots (1-day each)`);
        
        // Add to subtypeSlots
        subtypeSlots.push({
          subtypeId: subtype._id,
          slots: slots
        });
        
        totalSlotsCreated += slots.length;
      }
      
      // Create PlantSlot document for this year
      const plantSlot = new PlantSlot({
        plantId: papaya._id,
        year: year,
        subtypeSlots: subtypeSlots
      });
      
      await plantSlot.save();
      console.log(`\n   ✅ Created PlantSlot document for year ${year}`);
      console.log(`      Total slots: ${subtypeSlots.reduce((sum, st) => sum + st.slots.length, 0)}`);
    }
    
    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 CREATION SUMMARY');
    console.log('='.repeat(50));
    console.log(`Plant: ${papaya.name}`);
    console.log(`Years: 2025, 2026`);
    console.log(`Subtypes: ${papaya.subtypes.length}`);
    console.log(`Total Slots Created: ${totalSlotsCreated}`);
    console.log(`Slot Size: ${SLOT_SIZE} day`);
    console.log(`Total Plants per Slot: 0`);
    console.log(`Available Plants per Slot: 0`);
    
    // Verify creation
    console.log('\n🔍 Verifying creation...');
    const verifySlots = await PlantSlot.find({ plantId: papaya._id });
    console.log(`   Found ${verifySlots.length} PlantSlot document(s)`);
    
    let totalSlots = 0;
    let totalAvailable = 0;
    let totalPrimarySowed = 0;
    
    verifySlots.forEach(ps => {
      const slotsInYear = ps.subtypeSlots.reduce((sum, st) => sum + st.slots.length, 0);
      console.log(`   Year ${ps.year}: ${slotsInYear} slots across ${ps.subtypeSlots.length} subtypes`);
      
      ps.subtypeSlots?.forEach(st => {
        st.slots?.forEach(slot => {
          totalSlots++;
          totalAvailable += slot.availablePlants || 0;
          totalPrimarySowed += slot.primarySowed || 0;
        });
      });
    });
    
    console.log(`\n📊 Final Statistics:`);
    console.log(`   Total Slots: ${totalSlots}`);
    console.log(`   Total Available: ${totalAvailable}`);
    console.log(`   Total Primary Sowed: ${totalPrimarySowed}`);
    
    console.log('\n✅ Papaya slots recreated successfully as 1-day slots!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

recreatePapayaSlots();





