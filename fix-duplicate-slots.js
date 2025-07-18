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

// Improved slot generator: merges last short slot with previous slot
const generateSlotsForYear = (year, slotSize, capacity, startMonth = 'August', endMonth = 'December') => {
  const slots = [];
  let currentDate = moment(`01-${startMonth}-${year}`, 'DD-MMMM-YYYY');
  const endDate = moment(`31-${endMonth}-${year}`, 'DD-MMMM-YYYY');

  while (currentDate.isSameOrBefore(endDate)) {
    const monthEnd = currentDate.clone().endOf('month');
    let slotStart = currentDate.clone();
    let slotEnd = currentDate.clone().add(slotSize - 1, 'days');

    // If slotEnd goes past month end, adjust
    if (slotEnd.isAfter(monthEnd)) {
      slotEnd = monthEnd.clone();
    }

    // If this is the last slot of the month and it's too short, merge with previous
    if (slotEnd.isSame(monthEnd, 'day')) {
      const daysLeft = slotEnd.diff(slotStart, 'days') + 1;
      if (daysLeft < slotSize && slots.length > 0) {
        // Merge with previous slot
        slots[slots.length - 1].endDay = slotEnd.format('DD-MM-YYYY');
        slots[slots.length - 1].month = slotEnd.format('MMMM');
        slots[slots.length - 1].year = slotEnd.year();
        break;
      }
    }

    slots.push({
      startDay: slotStart.format('DD-MM-YYYY'),
      endDay: slotEnd.format('DD-MM-YYYY'),
      month: slotStart.format('MMMM'),
      year: slotStart.year(),
      totalPlants: capacity,
      bookedPlants: 0,
      availablePlants: capacity,
      isOverflow: false
    });

    currentDate = slotEnd.clone().add(1, 'days');
  }
  return slots;
};

const fixDuplicateSlots = async () => {
  try {
    await connectDB();

    // Delete all existing slots
    await PlantSlot.deleteMany({});
    console.log('🗑️ Deleted all existing slot configurations');

    // Get all plants
    const allPlants = await PlantCms.find({});
    console.log(`📋 Found ${allPlants.length} plant types`);

    // Create slots for each plant
    for (const plant of allPlants) {
      console.log(`\n🌱 Processing ${plant.name}...`);
      
      if (plant.name === 'Banana') {
        // Banana G-9: August 2025 to December 2026
        const g9Slots2025 = generateSlotsForYear(2025, 7, 212500, 'August', 'December');
        const g9Slots2026 = generateSlotsForYear(2026, 7, 212500, 'January', 'December');
        
        // Banana Vasai: August 2025 only
        const vasaiSlots2025 = generateSlotsForYear(2025, 7, 20000, 'August', 'December');
        
        // Create 2025 configuration with both G-9 and Vasai
        await PlantSlot.create({
          plantId: plant._id,
          year: 2025,
          subtypeSlots: [
            {
              subtypeId: plant.subtypes[0]._id, // G-9
              subtypeName: 'G-9',
              slots: g9Slots2025
            },
            {
              subtypeId: plant.subtypes[1]._id, // Vasai
              subtypeName: 'Vasai',
              slots: vasaiSlots2025
            }
          ]
        });
        
        // Create 2026 configuration with only G-9
        await PlantSlot.create({
          plantId: plant._id,
          year: 2026,
          subtypeSlots: [
            {
              subtypeId: plant.subtypes[0]._id, // G-9
              subtypeName: 'G-9',
              slots: g9Slots2026
            }
          ]
        });
        
        console.log(`   ✅ Created 2025: G-9 (${g9Slots2025.length} slots) + Vasai (${vasaiSlots2025.length} slots)`);
        console.log(`   ✅ Created 2026: G-9 (${g9Slots2026.length} slots)`);
        
      } else if (plant.name === 'Papaya') {
        // Papaya Taiwan: August 2025 to December 2025
        const taiwanSlots2025 = generateSlotsForYear(2025, 5, 100000, 'August', 'December');
        
        // Create 2025 configuration with Taiwan
        await PlantSlot.create({
          plantId: plant._id,
          year: 2025,
          subtypeSlots: [
            {
              subtypeId: plant.subtypes[0]._id, // Taiwan
              subtypeName: 'Taiwan',
              slots: taiwanSlots2025
            }
          ]
        });
        
        console.log(`   ✅ Created 2025: Taiwan (${taiwanSlots2025.length} slots)`);
      }
    }

    // Final verification
    const finalPlants = await PlantCms.find({});
    const finalSlots = await PlantSlot.find({});

    console.log('\n📊 FINAL SUMMARY:');
    console.log('==================');
    console.log(`Plant Types: ${finalPlants.length}`);
    console.log(`Slot Configurations: ${finalSlots.length}`);
    
    finalPlants.forEach(plant => {
      const plantSlots = finalSlots.filter(slot => slot.plantId.toString() === plant._id.toString());
      console.log(`\n${plant.name}:`);
      console.log(`  Subtypes: ${plant.subtypes.map(st => st.name).join(', ')}`);
      plantSlots.forEach(slot => {
        console.log(`  Year ${slot.year}: ${slot.subtypeSlots.length} subtypes`);
        slot.subtypeSlots.forEach(subtypeSlot => {
          const subtype = plant.subtypes.find(st => st._id.toString() === subtypeSlot.subtypeId.toString());
          console.log(`    - ${subtypeSlot.subtypeName}: ${subtypeSlot.slots.length} slots (${subtype?.slotSize}-day, Rate: ₹${subtype?.rate})`);
          console.log(`      Sample: ${subtypeSlot.slots[0].startDay} to ${subtypeSlot.slots[0].endDay} (${subtypeSlot.slots[0].totalPlants.toLocaleString()} capacity)`);
        });
      });
    });

    // Calculate totals
    const totalSlots = finalSlots.reduce((sum, slot) => {
      return sum + slot.subtypeSlots.reduce((subSum, subSlot) => subSum + subSlot.slots.length, 0);
    }, 0);

    console.log(`\n📈 Total Individual Slots: ${totalSlots}`);

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 MongoDB disconnected');
  }
};

fixDuplicateSlots(); 