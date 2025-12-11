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

const resetPrimarySowing = async () => {
  try {
    await connectDB();
    
    const PlantCms = (await import('./models/plantCms.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    // Target plants (case insensitive)
    const targetPlantNames = ['papaya', 'muskmelon', 'watermelon'];
    
    console.log('\n📊 Finding target plants...\n');
    
    // Find all plants matching the target names (case insensitive)
    const plants = await PlantCms.find({
      name: { $regex: new RegExp(targetPlantNames.join('|'), 'i') }
    }).select('_id name subtypes');
    
    if (plants.length === 0) {
      console.log('ℹ️  No matching plants found.');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`🌱 Found ${plants.length} matching plant(s):`);
    plants.forEach(plant => {
      console.log(`   - ${plant.name} (${plant._id})`);
      console.log(`     Subtypes: ${plant.subtypes?.map(s => s.name).join(', ') || 'None'}`);
    });
    
    const plantIds = plants.map(p => p._id);
    
    console.log('\n📊 Finding slots for these plants...\n');
    
    // Find all PlantSlot documents for these plants
    const plantSlots = await PlantSlot.find({
      plantId: { $in: plantIds }
    });
    
    if (plantSlots.length === 0) {
      console.log('ℹ️  No slots found for these plants.');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`📦 Found ${plantSlots.length} PlantSlot document(s)`);
    
    // Count slots and primarySowed values before update
    let totalSlots = 0;
    let slotsWithPrimary = 0;
    let totalPrimarySowed = 0;
    
    plantSlots.forEach(plantSlot => {
      plantSlot.subtypeSlots?.forEach(subtypeSlot => {
        subtypeSlot.slots?.forEach(slot => {
          totalSlots++;
          if (slot.primarySowed > 0) {
            slotsWithPrimary++;
            totalPrimarySowed += slot.primarySowed;
          }
        });
      });
    });
    
    console.log(`\n📊 Statistics before update:`);
    console.log(`   - Total slots: ${totalSlots}`);
    console.log(`   - Slots with primarySowed > 0: ${slotsWithPrimary}`);
    console.log(`   - Total primarySowed value: ${totalPrimarySowed}`);
    
    if (slotsWithPrimary === 0) {
      console.log('\nℹ️  No primary sowing data found. Nothing to reset.');
      await mongoose.connection.close();
      return;
    }
    
    console.log('\n🗑️  Resetting primarySowed to 0 for all slots...\n');
    
    // Update all slots to set primarySowed to 0
    let updatedCount = 0;
    let updatedSlots = 0;
    
    for (const plantSlot of plantSlots) {
      let hasChanges = false;
      
      if (plantSlot.subtypeSlots && Array.isArray(plantSlot.subtypeSlots)) {
        plantSlot.subtypeSlots.forEach(subtypeSlot => {
          if (subtypeSlot.slots && Array.isArray(subtypeSlot.slots)) {
            subtypeSlot.slots.forEach(slot => {
              if (slot.primarySowed > 0) {
                slot.primarySowed = 0;
                // Recalculate plantsSowed (total = officeSowed + primarySowed)
                slot.plantsSowed = (slot.officeSowed || 0) + 0;
                hasChanges = true;
                updatedSlots++;
              }
            });
          }
        });
      }
      
      if (hasChanges) {
        await plantSlot.save();
        updatedCount++;
      }
    }
    
    console.log(`✅ Updated ${updatedCount} PlantSlot document(s)`);
    console.log(`✅ Reset primarySowed for ${updatedSlots} slot(s)`);
    console.log(`\n✅ All primary sowing data reset to 0 for papaya, muskmelon, and watermelon!`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

resetPrimarySowing();

