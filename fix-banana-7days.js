import mongoose from 'mongoose';
import dotenv from 'dotenv';
import PlantCms from './models/plantCms.model.js';
import PlantSlot from './models/slots.model.js';
import moment from 'moment';

dotenv.config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

const generateSlotsForYear = (year, slotSize = 7) => {
  const slots = [];
  const startDate = moment(`01-08-${year}`, 'DD-MM-YYYY');
  const endDate = moment(`31-12-${year}`, 'DD-MM-YYYY');
  
  let currentDate = startDate.clone();
  
  while (currentDate.isSameOrBefore(endDate)) {
    const slotStart = currentDate.clone();
    const slotEnd = currentDate.clone().add(slotSize - 1, 'days');
    
    // If the remainder would be less than slotSize, extend to month end
    const daysUntilMonthEnd = currentDate.clone().endOf('month').diff(currentDate, 'days') + 1;
    if (daysUntilMonthEnd < slotSize && daysUntilMonthEnd > 0) {
      slotEnd.add(daysUntilMonthEnd - slotSize, 'days');
    }
    
    slots.push({
      startDay: slotStart.format('DD-MM-YYYY'),
      endDay: slotEnd.format('DD-MM-YYYY'),
      month: slotStart.format('MMMM'),
      year: slotStart.year(),
      totalPlants: 212500,
      bookedPlants: 0,
      availablePlants: 212500,
      isOverflow: false
    });
    
    currentDate = slotEnd.clone().add(1, 'days');
  }
  
  return slots;
};

const fixBananaTo7Days = async () => {
  try {
    await connectDB();

    // Find the Banana plant
    const bananaPlant = await PlantCms.findOne({ name: 'Banana' });
    if (!bananaPlant) {
      console.log('❌ Banana plant not found');
      return;
    }

    console.log('✅ Found Banana plant with subtypes:', bananaPlant.subtypes.map(st => st.name));

    // Update subtype slot sizes to 7 days
    bananaPlant.subtypes.forEach(subtype => {
      subtype.slotSize = 7;
    });
    await bananaPlant.save();

    // Delete existing slots for Banana
    const deleteResult = await PlantSlot.deleteMany({ plantId: bananaPlant._id });
    console.log(`🗑️ Deleted ${deleteResult.deletedCount} existing slot configurations`);

    // Create slots for 2025 and 2026 with 7-day slots
    const years = [2025, 2026];
    
    for (const year of years) {
      const slots = generateSlotsForYear(year, 7);
      
      const plantSlot = await PlantSlot.create({
        plantId: bananaPlant._id,
        year: year,
        subtypeSlots: bananaPlant.subtypes.map(subtype => ({
          subtypeId: subtype._id,
          subtypeName: subtype.name,
          slots: slots
        }))
      });

      console.log(`✅ Created ${slots.length} slots for Banana in ${year} (7-day slots)`);
      console.log(`   First slot: ${slots[0].startDay} to ${slots[0].endDay}`);
      console.log(`   Last slot: ${slots[slots.length - 1].startDay} to ${slots[slots.length - 1].endDay}`);
    }

    // Verify the creation
    const createdSlots = await PlantSlot.find({ plantId: bananaPlant._id });

    console.log('\n📋 Banana 7-Day Slots Verification:');
    console.log('===================================');
    console.log(`Plant: ${bananaPlant.name}`);
    console.log(`Subtypes: ${bananaPlant.subtypes.map(st => st.name).join(', ')}`);
    console.log(`Total slot configurations: ${createdSlots.length}`);
    
    createdSlots.forEach(slot => {
      console.log(`Year ${slot.year}: ${slot.subtypeSlots.length} subtype configurations`);
      slot.subtypeSlots.forEach(subtypeSlot => {
        console.log(`  - ${subtypeSlot.subtypeName}: ${subtypeSlot.slots.length} slots`);
        console.log(`    Sample slot: ${subtypeSlot.slots[0].startDay} to ${subtypeSlot.slots[0].endDay}`);
      });
    });

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 MongoDB disconnected');
  }
};

fixBananaTo7Days(); 