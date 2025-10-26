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

async function deleteSowingAllowedPlants() {
  try {
    console.log('🌱 Starting deletion of sowing-allowed plants and related data...\n');

    // Step 1: Find all sowing-allowed plants
    const sowingAllowedPlants = await PlantCms.find({ sowingAllowed: true });
    console.log(`📋 Found ${sowingAllowedPlants.length} sowing-allowed plants:`);
    sowingAllowedPlants.forEach(plant => {
      console.log(`   - ${plant.name} (ID: ${plant._id})`);
    });

    if (sowingAllowedPlants.length === 0) {
      console.log('✅ No sowing-allowed plants found. Nothing to delete.');
      return;
    }

    const plantIds = sowingAllowedPlants.map(plant => plant._id);
    console.log(`\n🔍 Plant IDs to delete: ${plantIds.join(', ')}\n`);

    // Step 2: Count related data before deletion
    console.log('📊 Counting related data...');
    
    const slotsCount = await PlantSlot.countDocuments({
      plantId: { $in: plantIds }
    });
    console.log(`   - Plant Slots: ${slotsCount}`);

    const ordersCount = await Order.countDocuments({
      'items.plantId': { $in: plantIds }
    });
    console.log(`   - Orders: ${ordersCount}`);

    const sowingsCount = await Sowing.countDocuments({
      plantId: { $in: plantIds }
    });
    console.log(`   - Sowing Records: ${sowingsCount}\n`);

    // Step 3: Delete related data in correct order (to avoid foreign key issues)
    console.log('🗑️  Starting deletion process...\n');

    // Delete Sowing records first
    if (sowingsCount > 0) {
      console.log('1. Deleting Sowing records...');
      const deletedSowings = await Sowing.deleteMany({
        plantId: { $in: plantIds }
      });
      console.log(`   ✅ Deleted ${deletedSowings.deletedCount} sowing records`);
    }

    // Delete Plant Slots
    if (slotsCount > 0) {
      console.log('2. Deleting Plant Slots...');
      const deletedSlots = await PlantSlot.deleteMany({
        plantId: { $in: plantIds }
      });
      console.log(`   ✅ Deleted ${deletedSlots.deletedCount} plant slots`);
    }

    // Update Orders to remove items with these plant IDs
    if (ordersCount > 0) {
      console.log('3. Updating Orders to remove items with deleted plants...');
      const updatedOrders = await Order.updateMany(
        { 'items.plantId': { $in: plantIds } },
        { $pull: { items: { plantId: { $in: plantIds } } } }
      );
      console.log(`   ✅ Updated ${updatedOrders.modifiedCount} orders`);
    }

    // Delete the plants themselves
    console.log('4. Deleting Plant CMS records...');
    const deletedPlants = await PlantCms.deleteMany({
      _id: { $in: plantIds }
    });
    console.log(`   ✅ Deleted ${deletedPlants.deletedCount} plant records`);

    // Step 4: Verify deletion
    console.log('\n🔍 Verifying deletion...');
    
    const remainingSlots = await PlantSlot.countDocuments({
      plantId: { $in: plantIds }
    });
    const remainingOrders = await Order.countDocuments({
      'items.plantId': { $in: plantIds }
    });
    const remainingSowings = await Sowing.countDocuments({
      plantId: { $in: plantIds }
    });
    const remainingPlants = await PlantCms.countDocuments({
      _id: { $in: plantIds }
    });

    console.log(`   - Remaining Plant Slots: ${remainingSlots}`);
    console.log(`   - Remaining Orders with these plants: ${remainingOrders}`);
    console.log(`   - Remaining Sowing Records: ${remainingSowings}`);
    console.log(`   - Remaining Plant Records: ${remainingPlants}`);

    if (remainingPlants === 0 && remainingSlots === 0 && remainingSowings === 0) {
      console.log('\n🎉 SUCCESS: All sowing-allowed plants and related data have been deleted!');
    } else {
      console.log('\n⚠️  WARNING: Some data may still remain. Please check manually.');
    }

  } catch (error) {
    console.error('❌ Error during deletion:', error);
  } finally {
    // Close database connection
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed.');
  }
}

// Run the deletion
await deleteSowingAllowedPlants();
