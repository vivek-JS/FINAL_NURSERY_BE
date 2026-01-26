import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";

// Production-ready MongoDB connection options
const mongoOptions = {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 10000,
  maxPoolSize: 10,
  minPoolSize: 1,
  retryWrites: true,
  w: 'majority',
  retryReads: true,
};

const checkCollections = async () => {
  try {
    console.log('🔌 Connecting to database...');
    
    await mongoose.connect(process.env.MONGO_URL, mongoOptions);
    
    console.log(`✅ Connected to database: ${mongoose.connection.name}@${mongoose.connection.host}:${mongoose.connection.port}`);
    console.log(`Database: ${mongoose.connection.db.databaseName}\n`);
    
    // List all collections
    const collections = await mongoose.connection.db.listCollections().toArray();
    
    if (collections.length === 0) {
      console.log('📭 No collections found in the database (database is empty)');
    } else {
      console.log(`📚 Found ${collections.length} collection(s):\n`);
      
      // Count documents in each collection
      for (const collection of collections) {
        const count = await mongoose.connection.db.collection(collection.name).countDocuments();
        console.log(`   ${collection.name}: ${count} document(s)`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from database');
  }
};

checkCollections();
