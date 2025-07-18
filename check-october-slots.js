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

const checkOctoberSlots = async () => {
  try {
    await connectDB();

    const allPlants = await PlantCms.find({});
    const allSlots = await PlantSlot.find({ year: 2025 });

    console.log('\n🔍 SLOTS FOR OCTOBER 2025');
    console.log('==========================');

    allPlants.forEach(plant => {
      const plantSlots = allSlots.filter(slot => slot.plantId.toString() === plant._id.toString());
      plantSlots.forEach(slot => {
        slot.subtypeSlots.forEach(subtypeSlot => {
          console.log(`\n${plant.name} - ${subtypeSlot.subtypeName}:`);
          const octoberSlots = subtypeSlot.slots.filter(s => {
            // Slot covers any day in October 2025
            const start = moment(s.startDay, 'DD-MM-YYYY');
            const end = moment(s.endDay, 'DD-MM-YYYY');
            return (
              (start.month() === 9 && start.year() === 2025) ||
              (end.month() === 9 && end.year() === 2025) ||
              (start.isBefore(moment('31-10-2025', 'DD-MM-YYYY')) && end.isAfter(moment('01-10-2025', 'DD-MM-YYYY')))
            );
          });
          if (octoberSlots.length === 0) {
            console.log('  No slots found for October 2025');
          } else {
            octoberSlots.forEach((s, i) => {
              console.log(`  Slot ${i + 1}: ${s.startDay} to ${s.endDay}`);
            });
          }
        });
      });
    });

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 MongoDB disconnected');
  }
};

checkOctoberSlots(); 