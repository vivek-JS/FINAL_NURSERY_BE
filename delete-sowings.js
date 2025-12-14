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
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
};

const deleteAllSowings = async () => {
  try {
    await connectDB();
    
    const Sowing = (await import('./models/sowing.model.js')).default;
    
    console.log('\n📊 Counting sowings before deletion...\n');
    
    // Count sowings before deletion
    const sowingsCount = await Sowing.countDocuments({});
    
    // Get breakdown by location type
    const officeSowings = await Sowing.countDocuments({ 
      $or: [
        { officeSowed: { $gt: 0 } },
        { sowingLocation: 'OFFICE' }
      ]
    });
    const primarySowings = await Sowing.countDocuments({ 
      $or: [
        { primarySowed: { $gt: 0 } },
        { sowingLocation: 'PRIMARY' }
      ]
    });
    
    console.log(`🌱 Total Sowing Records: ${sowingsCount} documents`);
    console.log(`📦 Records with Packets (officeSowed): ${officeSowings}`);
    console.log(`🌿 Records with Primary Sowing: ${primarySowings}\n`);
    
    if (sowingsCount === 0) {
      console.log('ℹ️  No sowing records found. Nothing to delete.');
      await mongoose.connection.close();
      return;
    }
    
    console.log('🗑️  Deleting all sowing records (including packets and primary sowing)...\n');
    
    // Delete all sowings
    const result = await Sowing.deleteMany({});
    
    console.log(`✅ Sowing Records: Deleted ${result.deletedCount} documents`);
    console.log(`\n✅ Total deleted: ${result.deletedCount} sowing documents`);
    console.log('✅ All sowings and packets deleted successfully! (No other data was affected)\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  }
};

deleteAllSowings();





