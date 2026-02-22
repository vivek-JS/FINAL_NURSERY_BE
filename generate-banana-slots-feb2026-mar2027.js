/**
 * Generate Banana G9 slots: 7-day slots from Feb 2026 to March 2027
 * Each slot: 225,000 total plants, 30% buffer → 157,500 available
 *
 * USAGE: node generate-banana-slots-feb2026-mar2027.js
 * Uses PROD_MONGO_URL or MONGO_URL from .env
 */

import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import moment from 'moment';

const connectDB = async () => {
  try {
    const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('PROD_MONGO_URL, MONGO_URL or MONGODB_URI required.');
    }
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
};

const generate7DaySlots = (startDate, endDate, slotSize, totalPlantsPerSlot, bufferPercent, plantReadyDays = 0) => {
  const slots = [];
  const start = moment(startDate, 'DD-MM-YYYY');
  const end = moment(endDate, 'DD-MM-YYYY');

  const bufferAmount = Math.round(totalPlantsPerSlot * (bufferPercent / 100));
  const availablePlants = totalPlantsPerSlot - bufferAmount;

  let currentDate = start.clone();

  while (currentDate.isSameOrBefore(end)) {
    const slotEnd = moment.min(
      currentDate.clone().add(slotSize - 1, 'days'),
      end.clone()
    );

    const startDay = currentDate.format('DD-MM-YYYY');
    const endDay = slotEnd.format('DD-MM-YYYY');
    const monthName = currentDate.format('MMMM');

    const slot = {
      startDay,
      endDay,
      month: monthName,
      totalPlants: totalPlantsPerSlot,
      totalBookedPlants: 0,
      availablePlants,
      buffer: bufferPercent,
      effectiveBuffer: bufferPercent,
      bufferAdjustedCapacity: availablePlants,
      bufferAmount,
      originalTotalPlants: totalPlantsPerSlot,
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
      slotTrail: [],
    };

    slots.push(slot);
    currentDate.add(slotSize, 'days');
  }

  return slots;
};

const run = async () => {
  try {
    await connectDB();

    const PlantCms = (await import('./models/plantCms.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;

    console.log('\n🍌 Banana G9 Slots: Feb 2026 – Mar 2027');
    console.log('═══════════════════════════════════════════════════════════\n');

    const bananaPlant = await PlantCms.findOne({
      name: { $regex: new RegExp('^banana$', 'i') },
    });

    if (!bananaPlant) {
      console.log('❌ Banana plant not found');
      return;
    }

    const g9Subtype = bananaPlant.subtypes?.find(
      (sub) => sub.name && (sub.name.toLowerCase().includes('g-9') || sub.name.toLowerCase().includes('g9'))
    );

    if (!g9Subtype) {
      console.log('❌ G9 subtype not found. Available:', bananaPlant.subtypes?.map((s) => s.name).join(', ') || 'none');
      return;
    }

    const plantReadyDays = g9Subtype.plantReadyDays || 0;

    const SLOT_SIZE = 7;
    const TOTAL_PLANTS = 225000;
    const BUFFER_PERCENT = 30;
    const START_DATE = '01-02-2026';
    const END_DATE = '31-03-2027';

    console.log('📋 Configuration:');
    console.log(`   Slot size: ${SLOT_SIZE} days`);
    console.log(`   Total plants per slot: ${TOTAL_PLANTS.toLocaleString()}`);
    console.log(`   Buffer: ${BUFFER_PERCENT}%`);
    console.log(`   Available per slot: ${(TOTAL_PLANTS * (1 - BUFFER_PERCENT / 100)).toLocaleString()}`);
    console.log(`   Date range: ${START_DATE} to ${END_DATE}\n`);

    const slots = generate7DaySlots(START_DATE, END_DATE, SLOT_SIZE, TOTAL_PLANTS, BUFFER_PERCENT, plantReadyDays);
    console.log(`   Generated ${slots.length} slots\n`);

    const years = [2026, 2027];
    for (const year of years) {
      const yearStart = year === 2026 ? moment('01-02-2026', 'DD-MM-YYYY') : moment('01-01-2027', 'DD-MM-YYYY');
      const yearEnd = year === 2026 ? moment('31-12-2026', 'DD-MM-YYYY') : moment('31-03-2027', 'DD-MM-YYYY');

      let plantSlot = await PlantSlot.findOne({ plantId: bananaPlant._id, year });

      if (!plantSlot) {
        plantSlot = new PlantSlot({ plantId: bananaPlant._id, year, subtypeSlots: [] });
        console.log(`✅ Created PlantSlot for year ${year}`);
      } else {
        console.log(`✅ Found PlantSlot for year ${year}`);
      }

      const slotsForYear = slots.filter((s) => {
        const d = moment(s.startDay, 'DD-MM-YYYY');
        return d.isSameOrAfter(yearStart) && d.isSameOrBefore(yearEnd);
      });

      const existingIdx = plantSlot.subtypeSlots.findIndex((st) => st.subtypeId.toString() === g9Subtype._id.toString());
      const subtypeSlot = { subtypeId: g9Subtype._id, slots: slotsForYear };

      if (existingIdx !== -1) {
        plantSlot.subtypeSlots[existingIdx] = subtypeSlot;
      } else {
        plantSlot.subtypeSlots.push(subtypeSlot);
      }

      await plantSlot.save();
      console.log(`   Saved ${slotsForYear.length} slots for year ${year}`);
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`✅ Done. ${slots.length} Banana G9 slots created.`);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

run();
