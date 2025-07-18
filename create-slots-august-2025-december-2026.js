import mongoose from 'mongoose';
import moment from 'moment';
import PlantCms from './models/plantCms.model.js';
import PlantSlot from './models/slots.model.js';
import dotenv from 'dotenv';

dotenv.config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Enhanced slot generator that works for any date range
const generateSlotsForDateRange = (startDate, endDate, slotSize = 7, capacity = 100000) => {
  const slots = [];
  let currentDate = moment(startDate, 'DD-MM-YYYY');
  const endMoment = moment(endDate, 'DD-MM-YYYY');

  while (currentDate.isSameOrBefore(endMoment)) {
    const slotStart = currentDate.clone();
    let slotEnd = currentDate.clone().add(slotSize - 1, 'days');

    // If slotEnd goes past the end date, adjust
    if (slotEnd.isAfter(endMoment)) {
      slotEnd = endMoment.clone();
    }

    // If slotEnd goes past month end, adjust to month end
    const monthEnd = slotStart.clone().endOf('month');
    if (slotEnd.isAfter(monthEnd)) {
      slotEnd = monthEnd.clone();
    }

    slots.push({
      startDay: slotStart.format('DD-MM-YYYY'),
      endDay: slotEnd.format('DD-MM-YYYY'),
      month: slotStart.format('MMMM'),
      year: slotStart.year(),
      totalPlants: capacity,
      totalBookedPlants: 0,
      buffer: 0,
      orders: [],
      allowedSalesmen: [],
      restrictToSalesmen: false,
      overflow: false,
      status: true,
    });

    currentDate = slotEnd.clone().add(1, 'days');
  }

  // Merge short last slot of each month with previous slot if needed
  let i = 1;
  while (i < slots.length) {
    const prev = slots[i - 1];
    const curr = slots[i];
    // If month changes, check if previous slot is short
    if (prev.month !== curr.month) {
      const prevStart = moment(prev.startDay, 'DD-MM-YYYY');
      const prevEnd = moment(prev.endDay, 'DD-MM-YYYY');
      const daysInPrevSlot = prevEnd.diff(prevStart, 'days') + 1;
      if (daysInPrevSlot < slotSize && i - 2 >= 0) {
        // Merge with the slot before previous
        slots[i - 2].endDay = prev.endDay;
        slots[i - 2].month = prev.month;
        slots.splice(i - 1, 1); // Remove prev
        i--;
      }
    }
    i++;
  }

  // Also check the very last slot in the range
  if (slots.length > 1) {
    const last = slots[slots.length - 1];
    const secondLast = slots[slots.length - 2];
    const lastStart = moment(last.startDay, 'DD-MM-YYYY');
    const lastEnd = moment(last.endDay, 'DD-MM-YYYY');
    const daysInLastSlot = lastEnd.diff(lastStart, 'days') + 1;
    if (daysInLastSlot < slotSize) {
      secondLast.endDay = last.endDay;
      secondLast.month = last.month;
      slots.pop();
    }
  }

  return slots;
};

const createSlotsForExtendedPeriod = async () => {
  try {
    await connectDB();

    // Delete all existing slots first
    await PlantSlot.deleteMany({});
    console.log('🗑️ Deleted all existing slot configurations');

    // Get all plants
    const allPlants = await PlantCms.find({});
    console.log(`📋 Found ${allPlants.length} plant types`);

    // Create slots for each plant
    for (const plant of allPlants) {
      console.log(`\n🌱 Processing ${plant.name}...`);

      // Prepare subtypeSlots for 2025 and 2026
      const subtypeSlots2025 = [];
      const subtypeSlots2026 = [];

      for (const subtype of plant.subtypes) {
        let slotSize = plant.slotSize || 7;
        let capacity = 100000;
        let slots2025 = [];
        let slots2026 = [];

        // Special logic for known subtypes
        if (plant.name === 'Banana' && subtype.name === 'G-9') {
          slotSize = 7;
          capacity = 212500;
          slots2025 = generateSlotsForDateRange('01-08-2025', '31-12-2025', slotSize, capacity);
          slots2026 = generateSlotsForDateRange('01-01-2026', '31-12-2026', slotSize, capacity);
        } else if (plant.name === 'Banana' && subtype.name === 'Vasai') {
          slotSize = 7;
          capacity = 20000;
          slots2025 = generateSlotsForDateRange('01-08-2025', '31-12-2025', slotSize, capacity);
          // No slots for Vasai in 2026
        } else if (plant.name === 'Papaya' && subtype.name === 'Taiwan') {
          slotSize = 5;
          capacity = 100000;
          slots2025 = generateSlotsForDateRange('01-08-2025', '31-12-2025', slotSize, capacity);
          slots2026 = generateSlotsForDateRange('01-01-2026', '31-12-2026', slotSize, capacity);
        } else {
          // Default for other subtypes
          slots2025 = generateSlotsForDateRange('01-08-2025', '31-12-2025', slotSize, capacity);
          slots2026 = generateSlotsForDateRange('01-01-2026', '31-12-2026', slotSize, capacity);
        }

        if (slots2025.length > 0) {
          subtypeSlots2025.push({
            subtypeId: subtype._id,
            subtypeName: subtype.name,
            slots: slots2025
          });
        }
        if (slots2026.length > 0) {
          subtypeSlots2026.push({
            subtypeId: subtype._id,
            subtypeName: subtype.name,
            slots: slots2026
          });
        }
      }

      // Create 2025 configuration
      if (subtypeSlots2025.length > 0) {
        await PlantSlot.create({
          plantId: plant._id,
          year: 2025,
          subtypeSlots: subtypeSlots2025
        });
        console.log(`   ✅ Created 2025: ${subtypeSlots2025.length} subtypes`);
      }
      // Create 2026 configuration
      if (subtypeSlots2026.length > 0) {
        await PlantSlot.create({
          plantId: plant._id,
          year: 2026,
          subtypeSlots: subtypeSlots2026
        });
        console.log(`   ✅ Created 2026: ${subtypeSlots2026.length} subtypes`);
      }
    }

    // Verify the creation
    const allSlots = await PlantSlot.find({}).populate('plantId', 'name');

    console.log('\n📋 Final Slot Configuration Summary:');
    console.log('=====================================');

    const slotSummary = {};
    allSlots.forEach(slot => {
      const plantName = slot.plantId.name;
      const year = slot.year;
      const totalSlots = slot.subtypeSlots.reduce((total, st) => total + st.slots.length, 0);

      if (!slotSummary[plantName]) {
        slotSummary[plantName] = {};
      }
      slotSummary[plantName][year] = totalSlots;
    });

    Object.keys(slotSummary).forEach(plantName => {
      console.log(`\n🌱 ${plantName}:`);
      Object.keys(slotSummary[plantName]).forEach(year => {
        console.log(`   ${year}: ${slotSummary[plantName][year]} slots`);
      });
    });

    console.log(`\n✅ Total slot configurations created: ${allSlots.length}`);
    console.log('🎉 Slot generation completed successfully!');

  } catch (error) {
    console.error('❌ Error creating slots:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
};

// Run the script
createSlotsForExtendedPeriod(); 