import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGO_URL or MONGODB_URI environment variable is required.');
    }
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB\n');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
};

const checkSowingInProgress = async () => {
  try {
    await connectDB();
    
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    const slots = await PlantSlot.find({ 
      'subtypeSlots.slots.sowingInProgress.0': { $exists: true } 
    }).lean();
    
    console.log(`📊 Found ${slots.length} slot document(s) with sowingInProgress entries\n`);
    
    let totalEntries = 0;
    for (const ps of slots) {
      for (const st of ps.subtypeSlots || []) {
        for (const slot of st.slots || []) {
          if (slot.sowingInProgress && slot.sowingInProgress.length > 0) {
            totalEntries += slot.sowingInProgress.length;
            console.log(`Slot ${slot._id}:`);
            console.log(`   - Start Day: ${slot.startDay}`);
            console.log(`   - Sowing In Progress: ${slot.sowingInProgress.length} entries`);
            slot.sowingInProgress.forEach((entry, idx) => {
              console.log(`     Entry ${idx + 1}: requestNumber=${entry.requestNumber}, packetsIssued=${entry.packetsIssued}`);
            });
            console.log('');
          }
        }
      }
    }
    
    if (totalEntries === 0) {
      console.log('✅ No slots with sowingInProgress entries found!');
    } else {
      console.log(`⚠️  Total sowingInProgress entries: ${totalEntries}`);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

checkSowingInProgress();


