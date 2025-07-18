import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Delete all orders and reset slots
const deleteOrdersAndResetSlots = async () => {
  try {
    // Import the models
    const { default: Order } = await import('./models/order.model.js');
    const { default: PlantSlot } = await import('./models/slots.model.js');
    
    console.log('🚀 Starting comprehensive cleanup...');
    
    // Step 1: Count orders before deletion
    const orderCount = await Order.countDocuments();
    console.log(`📊 Found ${orderCount} orders to delete`);
    
    // Step 2: Delete all orders
    if (orderCount > 0) {
      const orderResult = await Order.deleteMany({});
      console.log(`✅ Successfully deleted ${orderResult.deletedCount} orders`);
    } else {
      console.log('✅ No orders found to delete');
    }
    
    // Step 3: Reset all slots to original capacity
    console.log('🔄 Resetting all slots to original capacity...');
    
    const plantSlots = await PlantSlot.find({});
    console.log(`📊 Found ${plantSlots.length} plant slot configurations`);
    
    let resetCount = 0;
    let totalSlotsReset = 0;
    
    for (const plantSlot of plantSlots) {
      for (const subtypeSlot of plantSlot.subtypeSlots) {
        for (const slot of subtypeSlot.slots) {
          // Reset slot to original capacity
          slot.totalBookedPlants = 0;
          slot.orders = [];
          slot.overflow = false;
          slot.status = false; // Boolean field - false means available
          slot.isOverflow = false;
          totalSlotsReset++;
        }
      }
      resetCount++;
    }
    
    // Save all changes
    await Promise.all(plantSlots.map(ps => ps.save()));
    
    console.log(`✅ Reset ${totalSlotsReset} slots across ${resetCount} plant configurations`);
    
    // Step 4: Verify cleanup
    const remainingOrders = await Order.countDocuments();
    console.log(`📊 Remaining orders: ${remainingOrders}`);
    
    // Check a sample slot to verify reset
    const samplePlantSlot = await PlantSlot.findOne({});
    if (samplePlantSlot) {
      const sampleSlot = samplePlantSlot.subtypeSlots[0]?.slots[0];
      if (sampleSlot) {
        console.log(`📋 Sample slot verification:`);
        console.log(`   - totalBookedPlants: ${sampleSlot.totalBookedPlants}`);
        console.log(`   - orders count: ${sampleSlot.orders.length}`);
        console.log(`   - overflow: ${sampleSlot.overflow}`);
        console.log(`   - status: ${sampleSlot.status}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
  }
};

// Main execution
const main = async () => {
  console.log('🚀 Starting comprehensive database cleanup...');
  
  await connectDB();
  await deleteOrdersAndResetSlots();
  
  console.log('✅ Comprehensive cleanup completed successfully');
  
  // Close database connection
  await mongoose.connection.close();
  console.log('🔌 Database connection closed');
  
  process.exit(0);
};

// Run the script
main().catch((error) => {
  console.error('❌ Script execution failed:', error);
  process.exit(1);
}); 