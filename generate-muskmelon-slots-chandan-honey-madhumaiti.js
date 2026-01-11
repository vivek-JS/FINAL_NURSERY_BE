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
 * @param {string} startDate - Start date in DD-MM-YYYY format
 * @param {string} endDate - End date in DD-MM-YYYY format
 * @param {number} plantReadyDays - Plant ready days from subtype
 * @returns {Array} Array of slot objects
 */
const generateSlots = (startDate, endDate, plantReadyDays = 0) => {
  const slots = [];
  const start = moment(startDate, 'DD-MM-YYYY');
  const end = moment(endDate, 'DD-MM-YYYY');
  
  let currentDate = start.clone();
  
  while (currentDate.isSameOrBefore(end)) {
    const startDay = currentDate.format('DD-MM-YYYY');
    const endDay = currentDate.format('DD-MM-YYYY'); // Same day for 1-day slots
    const monthName = currentDate.format('MMMM');
    
    // Create slot object with 0 totalPlants and availablePlants
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
      reminderBeforePlantReadyDays: 0,
      slotTrail: []
    };
    
    slots.push(slot);
    
    // Move to next day
    currentDate.add(1, 'days');
  }
  
  return slots;
};

const setupMuskmelonSlots = async () => {
  try {
    await connectDB();
    
    const PlantCms = (await import('./models/plantCms.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    console.log('\n🍈 Generating Slots for Muskmelon Varieties: Chandan, Honey, Madhumati');
    console.log('═══════════════════════════════════════════════════════════════════════\n');
    
    // Find muskmelon plant
    const muskmelonPlant = await PlantCms.findOne({
      name: { $regex: new RegExp('^muskmelon$', 'i') }
    });
    
    if (!muskmelonPlant) {
      console.log('❌ Muskmelon plant not found in database');
      return;
    }
    
    console.log(`✅ Found plant: ${muskmelonPlant.name} (${muskmelonPlant._id})`);
    console.log(`   Total Subtypes: ${muskmelonPlant.subtypes?.length || 0}\n`);
    
    // Find the three subtypes
    const targetSubtypes = ['chandan', 'honey', 'madhumati'];
    const foundSubtypes = [];
    
    for (const targetName of targetSubtypes) {
      const subtype = muskmelonPlant.subtypes.find(st => 
        st.name.toLowerCase() === targetName.toLowerCase()
      );
      
      if (subtype) {
        foundSubtypes.push(subtype);
        console.log(`✅ Found subtype: ${subtype.name} (${subtype._id})`);
        console.log(`   Plant Ready Days: ${subtype.plantReadyDays || 0}`);
      } else {
        console.log(`❌ Subtype "${targetName}" not found`);
      }
    }
    
    if (foundSubtypes.length === 0) {
      console.log('\n❌ No target subtypes found. Please ensure chandan, honey, and madhumati are added to muskmelon.');
      return;
    }
    
    console.log(`\n📋 Processing ${foundSubtypes.length} subtype(s)\n`);
    
    // Update plant slotSize to 1 if needed
    if (muskmelonPlant.slotSize !== 1) {
      muskmelonPlant.slotSize = 1;
      await muskmelonPlant.save();
      console.log(`✅ Updated muskmelon slotSize to 1 day\n`);
    }
    
    // Generate slots from today (19-12-2025) to end of 2026 (31-12-2026)
    const startDate = '19-12-2025';
    const endDate = '31-12-2026';
    
    const years = [2025, 2026];
    
    for (const year of years) {
      console.log(`\n${'='.repeat(70)}`);
      console.log(`📅 Processing Year ${year}`);
      console.log(`${'='.repeat(70)}\n`);
      
      // Calculate date range for this year
      let yearStartDate, yearEndDate;
      
      if (year === 2025) {
        yearStartDate = '19-12-2025'; // Start from Dec 19, 2025
        yearEndDate = '31-12-2025';   // End of 2025
      } else {
        yearStartDate = '01-01-2026'; // Start of 2026
        yearEndDate = '31-12-2026';   // End of 2026
      }
      
      console.log(`Date Range: ${yearStartDate} to ${yearEndDate}`);
      
      // Find or create PlantSlot document for this year
      let plantSlot = await PlantSlot.findOne({
        plantId: muskmelonPlant._id,
        year: year
      });
      
      if (!plantSlot) {
        // Create new PlantSlot document
        plantSlot = new PlantSlot({
          plantId: muskmelonPlant._id,
          year: year,
          subtypeSlots: []
        });
        console.log(`✅ Created new PlantSlot document for year ${year}`);
      } else {
        console.log(`✅ Found existing PlantSlot document for year ${year}`);
      }
      
      // Process each subtype
      for (const subtype of foundSubtypes) {
        const plantReadyDays = subtype.plantReadyDays || 0;
        
        // Generate slots for this subtype and year
        const slots = generateSlots(
          yearStartDate,
          yearEndDate,
          plantReadyDays
        );
        
        console.log(`\n   🌱 ${subtype.name}:`);
        console.log(`      Subtype ID: ${subtype._id}`);
        console.log(`      Plant Ready Days: ${plantReadyDays}`);
        console.log(`      Slots to create: ${slots.length}`);
        
        // Check if subtypeSlots already exists for this subtype
        const existingSubtypeSlotIndex = plantSlot.subtypeSlots.findIndex(
          st => st.subtypeId.toString() === subtype._id.toString()
        );
        
        if (existingSubtypeSlotIndex !== -1) {
          // Update existing subtypeSlots
          const existingSlots = plantSlot.subtypeSlots[existingSubtypeSlotIndex].slots;
          
          // Merge: only add new slots that don't already exist
          let addedCount = 0;
          for (const newSlot of slots) {
            const exists = existingSlots.some(
              existing => existing.startDay === newSlot.startDay && existing.endDay === newSlot.endDay
            );
            
            if (!exists) {
              existingSlots.push(newSlot);
              addedCount++;
            }
          }
          
          plantSlot.subtypeSlots[existingSubtypeSlotIndex].slots = existingSlots;
          console.log(`      ✅ Updated: ${addedCount} new slots added, ${existingSlots.length - addedCount} existing slots kept`);
          console.log(`      Total slots for ${subtype.name}: ${existingSlots.length}`);
        } else {
          // Add new subtypeSlots
          plantSlot.subtypeSlots.push({
            subtypeId: subtype._id,
            slots: slots
          });
          console.log(`      ✅ Added: ${slots.length} slots for ${subtype.name}`);
        }
      }
      
      // Save the PlantSlot document
      await plantSlot.save();
      console.log(`\n✅ Saved PlantSlot document for year ${year}`);
      
      // Show summary for this year
      const totalSlots = plantSlot.subtypeSlots.reduce((sum, st) => sum + st.slots.length, 0);
      console.log(`   Total slots in year ${year}: ${totalSlots}`);
    }
    
    // Final Summary
    console.log('\n' + '='.repeat(70));
    console.log('📊 FINAL SUMMARY');
    console.log('='.repeat(70));
    
    const allSlots = await PlantSlot.find({ plantId: muskmelonPlant._id });
    
    let grandTotal = 0;
    for (const ps of allSlots) {
      console.log(`\nYear ${ps.year}:`);
      for (const st of ps.subtypeSlots) {
        const subtype = foundSubtypes.find(s => s._id.toString() === st.subtypeId.toString());
        const subtypeName = subtype ? subtype.name : 'Unknown';
        console.log(`   ${subtypeName}: ${st.slots.length} slots`);
        grandTotal += st.slots.length;
      }
    }
    
    console.log(`\n🎯 GRAND TOTAL: ${grandTotal} slots created`);
    console.log('✅ Slot generation completed successfully!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

setupMuskmelonSlots();






