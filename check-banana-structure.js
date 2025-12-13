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

const checkBananaStructure = async () => {
  try {
    await connectDB();
    
    const PlantCms = (await import('./models/plantCms.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    console.log('\n📊 Checking Banana Plant Structure...\n');
    
    // Find Banana plant
    const banana = await PlantCms.findOne({
      name: { $regex: new RegExp('^banana$', 'i') }
    });
    
    if (!banana) {
      console.log('❌ Banana plant not found');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`✅ Found Banana: ${banana.name} (${banana._id})`);
    console.log(`   Slot Size: ${banana.slotSize || 'Not set'}`);
    console.log(`   Sowing Allowed: ${banana.sowingAllowed || false}`);
    console.log(`   Subtypes: ${banana.subtypes?.length || 0}\n`);
    
    if (banana.subtypes && banana.subtypes.length > 0) {
      console.log('📋 Banana Subtypes:');
      banana.subtypes.forEach((subtype, idx) => {
        console.log(`   ${idx + 1}. ${subtype.name} (${subtype._id})`);
        console.log(`      Plant Ready Days: ${subtype.plantReadyDays || 'Not set'}`);
      });
    }
    
    // Check existing slots
    console.log('\n📊 Checking Existing Slots...\n');
    const existingSlots = await PlantSlot.find({
      plantId: banana._id
    });
    
    console.log(`Found ${existingSlots.length} PlantSlot document(s) for Banana`);
    existingSlots.forEach(slot => {
      console.log(`   Year: ${slot.year}, Subtypes: ${slot.subtypeSlots?.length || 0}`);
    });
    
    await mongoose.connection.close();
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    process.exit(0);
  }
};

checkBananaStructure();




