/**
 * Set sowingAllowed = false for Banana plant.
 * Uses PROD_MONGO_URL or MONGO_URL from .env
 */

import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

const connectDB = async () => {
  const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL || process.env.MONGODB_URI;
  if (!uri) throw new Error('PROD_MONGO_URL, MONGO_URL or MONGODB_URI required.');
  await mongoose.connect(uri);
  console.log('✅ Connected to MongoDB');
};

const run = async () => {
  try {
    await connectDB();
    const PlantCms = (await import('./models/plantCms.model.js')).default;

    const banana = await PlantCms.findOne({ name: { $regex: /^banana$/i } });
    if (!banana) {
      console.log('❌ Banana plant not found');
      return;
    }

    console.log(`\n🍌 Banana: ${banana.name} (${banana._id})`);
    console.log(`   sowingAllowed before: ${banana.sowingAllowed}\n`);

    const result = await PlantCms.updateOne(
      { _id: banana._id },
      { $set: { sowingAllowed: false } }
    );

    if (result.modifiedCount > 0) {
      console.log('✅ sowingAllowed set to false for Banana\n');
    } else {
      console.log('ℹ️  Banana already had sowingAllowed=false\n');
    }

    // Subtypes don't have sowingAllowed in PlantCms - it's plant-level only
    console.log('   (sowingAllowed is plant-level; subtypes inherit from plant)\n');
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  }
};

run();
