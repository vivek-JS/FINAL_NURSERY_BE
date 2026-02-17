import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
import PlantSlot from '../models/slots.model.js';

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

const findAvailableSlots = async () => {
  try {
    console.log('\n🔍 Finding available slots in database...\n');
    
    const plantSlots = await PlantSlot.find({})
      .populate('plantId', 'name')
      .limit(5)
      .lean();

    if (plantSlots.length === 0) {
      console.log('❌ No slots found in database');
      return;
    }

    console.log(`Found ${plantSlots.length} PlantSlot document(s)\n`);

    for (const plantSlot of plantSlots) {
      console.log(`🌱 Plant: ${plantSlot.plantId?.name || 'N/A'} (Year: ${plantSlot.year})`);
      console.log(`   Subtype Slots: ${plantSlot.subtypeSlots?.length || 0}`);
      
      for (const subtypeSlot of plantSlot.subtypeSlots || []) {
        if (subtypeSlot.slots && subtypeSlot.slots.length > 0) {
          const firstSlot = subtypeSlot.slots[0];
          console.log(`\n   📦 Sample Slot:`);
          console.log(`      Slot ID: ${firstSlot._id}`);
          console.log(`      Start Day: ${firstSlot.startDay}`);
          console.log(`      End Day: ${firstSlot.endDay}`);
          console.log(`      Total Plants: ${firstSlot.totalPlants || 0}`);
          console.log(`      Available Plants: ${firstSlot.availablePlants || 0}`);
          console.log(`      Status: ${firstSlot.status}`);
          console.log(`\n   ✅ Use this slotId for testing: ${firstSlot._id}\n`);
          break;
        }
      }
    }

  } catch (error) {
    console.error('❌ Error finding slots:', error);
  }
};

const main = async () => {
  await connectDB();
  await findAvailableSlots();
  await mongoose.disconnect();
  console.log('\n✅ Disconnected from MongoDB');
  process.exit(0);
};

main();





