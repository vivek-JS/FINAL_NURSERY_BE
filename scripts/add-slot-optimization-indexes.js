import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

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

const addIndexes = async () => {
  try {
    const db = mongoose.connection.db;
    
    console.log('\n📊 Adding indexes for slot query optimization...\n');
    
    // PlantSlot indexes
    console.log('1. Adding PlantSlot indexes...');
    try {
      await db.collection('plantslots').createIndex(
        { plantId: 1, year: 1 },
        { name: 'plantId_year_1', background: true }
      );
      console.log('   ✅ Created index: plantId + year (compound)');
    } catch (error) {
      if (error.code === 85) {
        console.log('   ⚠️  Index already exists: plantId + year');
      } else {
        throw error;
      }
    }
    
    try {
      await db.collection('plantslots').createIndex(
        { 'subtypeSlots.subtypeId': 1 },
        { name: 'subtypeSlots.subtypeId_1', background: true }
      );
      console.log('   ✅ Created index: subtypeSlots.subtypeId');
    } catch (error) {
      if (error.code === 85) {
        console.log('   ⚠️  Index already exists: subtypeSlots.subtypeId');
      } else {
        throw error;
      }
    }
    
    try {
      await db.collection('plantslots').createIndex(
        { 'subtypeSlots.slots._id': 1 },
        { name: 'subtypeSlots.slots._id_1', background: true }
      );
      console.log('   ✅ Created index: subtypeSlots.slots._id');
    } catch (error) {
      if (error.code === 85) {
        console.log('   ⚠️  Index already exists: subtypeSlots.slots._id');
      } else {
        throw error;
      }
    }
    
    // Order indexes
    console.log('\n2. Adding Order indexes...');
    try {
      await db.collection('orders').createIndex(
        { bookingSlot: 1, orderStatus: 1 },
        { name: 'bookingSlot_orderStatus_1', background: true }
      );
      console.log('   ✅ Created index: bookingSlot + orderStatus (compound)');
    } catch (error) {
      if (error.code === 85) {
        console.log('   ⚠️  Index already exists: bookingSlot + orderStatus');
      } else {
        throw error;
      }
    }
    
    try {
      await db.collection('orders').createIndex(
        { bookingSlot: 1, orderStatus: 1, quotaSource: 1 },
        { name: 'bookingSlot_orderStatus_quotaSource_1', background: true }
      );
      console.log('   ✅ Created index: bookingSlot + orderStatus + quotaSource (compound)');
    } catch (error) {
      if (error.code === 85) {
        console.log('   ⚠️  Index already exists: bookingSlot + orderStatus + quotaSource');
      } else {
        throw error;
      }
    }
    
    console.log('\n✅ All indexes added successfully!\n');
    console.log('📈 Performance improvements:');
    console.log('   - PlantSlot queries by plantId + year will be much faster');
    console.log('   - Order queries by bookingSlot + orderStatus will be optimized');
    console.log('   - Batch queries in populateSlotsWithOrders will use indexes efficiently\n');
    
  } catch (error) {
    console.error('❌ Error adding indexes:', error);
    throw error;
  }
};

const main = async () => {
  try {
    await connectDB();
    await addIndexes();
    await mongoose.connection.close();
    console.log('✅ Migration completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
};

main();


