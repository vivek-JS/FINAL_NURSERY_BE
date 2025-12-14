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

const deleteMuskmelonSlots = async () => {
  try {
    await connectDB();
    
    const PlantCms = (await import('./models/plantCms.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    // Target plant: Muskmelon
    const targetPlantName = 'muskmelon';
    
    console.log('\n📊 Finding Muskmelon plant...\n');
    
    // Find muskmelon plant (case insensitive)
    const plant = await PlantCms.findOne({
      name: { $regex: new RegExp(`^${targetPlantName}$`, 'i') }
    }).select('_id name subtypes');
    
    if (!plant) {
      console.log('❌ Muskmelon plant not found.');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`✅ Found plant: ${plant.name} (${plant._id})`);
    console.log(`   Subtypes: ${plant.subtypes?.length || 0}`);
    if (plant.subtypes && plant.subtypes.length > 0) {
      plant.subtypes.forEach((subtype, idx) => {
        console.log(`      ${idx + 1}. ${subtype.name} (${subtype._id})`);
      });
    }
    
    console.log('\n📊 Finding slots for Muskmelon...\n');
    
    // Find all PlantSlot documents for muskmelon
    const plantSlots = await PlantSlot.find({
      plantId: plant._id
    });
    
    if (plantSlots.length === 0) {
      console.log('ℹ️  No slots found for Muskmelon.');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`📦 Found ${plantSlots.length} PlantSlot document(s) for Muskmelon`);
    
    // Count slots and values before deletion
    let totalSlots = 0;
    let totalAvailablePlants = 0;
    let totalPrimarySowed = 0;
    
    plantSlots.forEach(plantSlot => {
      console.log(`\n   Year: ${plantSlot.year}`);
      plantSlot.subtypeSlots?.forEach(subtypeSlot => {
        console.log(`      Subtype: ${subtypeSlot.subtypeName || 'Unknown'}`);
        subtypeSlot.slots?.forEach(slot => {
          totalSlots++;
          totalAvailablePlants += slot.availablePlants || 0;
          totalPrimarySowed += slot.primarySowed || 0;
        });
      });
    });
    
    console.log(`\n📊 Statistics before deletion:`);
    console.log(`   - Total slots: ${totalSlots}`);
    console.log(`   - Total availablePlants: ${totalAvailablePlants.toLocaleString()}`);
    console.log(`   - Total primarySowed: ${totalPrimarySowed.toLocaleString()}`);
    
    // Delete all PlantSlot documents for muskmelon
    console.log('\n🗑️  Deleting all Muskmelon slots...\n');
    
    const deleteResult = await PlantSlot.deleteMany({
      plantId: plant._id
    });
    
    console.log(`✅ Deleted ${deleteResult.deletedCount} PlantSlot document(s)`);
    console.log(`✅ Deleted ${totalSlots} total slots`);
    
    // Verify deletion
    console.log('\n🔍 Verifying deletion...\n');
    const remainingSlots = await PlantSlot.find({
      plantId: plant._id
    });
    
    if (remainingSlots.length === 0) {
      console.log('✅ SUCCESS! All Muskmelon slots have been deleted.');
      console.log(`   - Deleted ${totalSlots} slots`);
      console.log(`   - Cleared ${totalAvailablePlants.toLocaleString()} availablePlants`);
      console.log(`   - Cleared ${totalPrimarySowed.toLocaleString()} primarySowed`);
    } else {
      console.log(`⚠️  WARNING: ${remainingSlots.length} PlantSlot document(s) still exist.`);
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

deleteMuskmelonSlots();





