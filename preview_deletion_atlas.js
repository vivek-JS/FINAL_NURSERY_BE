import mongoose from 'mongoose';

// Database connection - using the same Atlas database as the backend
const MONGODB_URI = 'mongodb+srv://vivek-db:Bk!A9CrCh79kC_h@cluster0.agsluxe.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

// Connect to MongoDB
await mongoose.connect(MONGODB_URI);

// Import models
import PlantCms from './models/plantcms.model.js';
import PlantSlot from './models/slots.model.js';
import Order from './models/order.model.js';
import Sowing from './models/sowing.model.js';

async function previewDeletion() {
  try {
    console.log('🔍 PREVIEW: What would be deleted if we remove sowing-allowed plants...\n');

    // Find all sowing-allowed plants
    const sowingAllowedPlants = await PlantCms.find({ sowingAllowed: true });
    console.log(`📋 Sowing-allowed plants found: ${sowingAllowedPlants.length}`);
    sowingAllowedPlants.forEach(plant => {
      console.log(`   - ${plant.name} (ID: ${plant._id})`);
    });

    if (sowingAllowedPlants.length === 0) {
      console.log('✅ No sowing-allowed plants found. Nothing would be deleted.');
      return;
    }

    const plantIds = sowingAllowedPlants.map(plant => plant._id);

    // Count related data
    console.log('\n📊 Related data that would be deleted:');
    
    const slotsCount = await PlantSlot.countDocuments({
      plantId: { $in: plantIds }
    });
    console.log(`   - Plant Slots: ${slotsCount}`);

    const ordersCount = await Order.countDocuments({
      'items.plantId': { $in: plantIds }
    });
    console.log(`   - Orders containing these plants: ${ordersCount}`);

    const sowingsCount = await Sowing.countDocuments({
      plantId: { $in: plantIds }
    });
    console.log(`   - Sowing Records: ${sowingsCount}`);

    // Show some sample data
    console.log('\n📋 Sample data that would be affected:');
    
    if (slotsCount > 0) {
      const sampleSlots = await PlantSlot.find({
        plantId: { $in: plantIds }
      }).limit(3);
      console.log('\n   Sample Plant Slots:');
      sampleSlots.forEach(slot => {
        console.log(`     - Plant ID: ${slot.plantId}, Month: ${slot.month}`);
      });
    }

    if (ordersCount > 0) {
      const sampleOrders = await Order.find({
        'items.plantId': { $in: plantIds }
      }).limit(3);
      console.log('\n   Sample Orders:');
      sampleOrders.forEach(order => {
        console.log(`     - Order ID: ${order._id}, Items: ${order.items.length}`);
      });
    }

    if (sowingsCount > 0) {
      const sampleSowings = await Sowing.find({
        plantId: { $in: plantIds }
      }).limit(3);
      console.log('\n   Sample Sowing Records:');
      sampleSowings.forEach(sowing => {
        console.log(`     - Plant ID: ${sowing.plantId}, Quantity: ${sowing.totalQuantityRequired}`);
      });
    }

    console.log('\n⚠️  WARNING: This is a preview only. No data has been deleted.');
    console.log('   To actually delete, run: node delete_sowing_plants_atlas.js');

  } catch (error) {
    console.error('❌ Error during preview:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed.');
  }
}

// Run the preview
await previewDeletion();
