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

// Comprehensive fix for slot-order connections
const fixSlotOrderConnections = async () => {
  try {
    // Import the models
    const { default: Order } = await import('./models/order.model.js');
    const { default: PlantSlot } = await import('./models/slots.model.js');
    
    console.log('🚀 Starting comprehensive slot-order connection fix...');
    
    // Step 1: Check current state
    const orderCount = await Order.countDocuments();
    const plantSlotCount = await PlantSlot.countDocuments();
    
    console.log(`📊 Current state:`);
    console.log(`   - Orders: ${orderCount}`);
    console.log(`   - Plant slot configurations: ${plantSlotCount}`);
    
    // Step 2: Get all plant slots and analyze their order references
    const plantSlots = await PlantSlot.find({});
    let totalSlots = 0;
    let slotsWithOrders = 0;
    let totalOrderReferences = 0;
    
    for (const plantSlot of plantSlots) {
      for (const subtypeSlot of plantSlot.subtypeSlots) {
        for (const slot of subtypeSlot.slots) {
          totalSlots++;
          if (slot.orders && slot.orders.length > 0) {
            slotsWithOrders++;
            totalOrderReferences += slot.orders.length;
          }
        }
      }
    }
    
    console.log(`📋 Slot analysis:`);
    console.log(`   - Total slots: ${totalSlots}`);
    console.log(`   - Slots with order references: ${slotsWithOrders}`);
    console.log(`   - Total order references: ${totalOrderReferences}`);
    
    // Step 3: Clear all order references from slots
    console.log('🔄 Clearing all order references from slots...');
    
    let clearedSlots = 0;
    let clearedReferences = 0;
    
    for (const plantSlot of plantSlots) {
      let plantSlotModified = false;
      
      for (const subtypeSlot of plantSlot.subtypeSlots) {
        for (const slot of subtypeSlot.slots) {
          if (slot.orders && slot.orders.length > 0) {
            const orderCount = slot.orders.length;
            slot.orders = [];
            slot.totalBookedPlants = 0;
            slot.overflow = false;
            slot.isOverflow = false;
            slot.status = false;
            plantSlotModified = true;
            clearedSlots++;
            clearedReferences += orderCount;
          }
        }
      }
      
      // Save the plant slot if it was modified
      if (plantSlotModified) {
        await plantSlot.save();
      }
    }
    
    console.log(`✅ Cleared ${clearedReferences} order references from ${clearedSlots} slots`);
    
    // Step 4: Verify cleanup
    console.log('🔍 Verifying cleanup...');
    
    const updatedPlantSlots = await PlantSlot.find({});
    let remainingOrderReferences = 0;
    
    for (const plantSlot of updatedPlantSlots) {
      for (const subtypeSlot of plantSlot.subtypeSlots) {
        for (const slot of subtypeSlot.slots) {
          if (slot.orders && slot.orders.length > 0) {
            remainingOrderReferences += slot.orders.length;
          }
        }
      }
    }
    
    console.log(`📊 Verification results:`);
    console.log(`   - Remaining order references: ${remainingOrderReferences}`);
    
    // Step 5: Check for any orphaned orders (should be 0)
    const remainingOrders = await Order.countDocuments();
    console.log(`   - Remaining orders: ${remainingOrders}`);
    
    // Step 6: Sample verification
    const samplePlantSlot = await PlantSlot.findOne({});
    if (samplePlantSlot) {
      const sampleSlot = samplePlantSlot.subtypeSlots[0]?.slots[0];
      if (sampleSlot) {
        console.log(`📋 Sample slot verification:`);
        console.log(`   - totalBookedPlants: ${sampleSlot.totalBookedPlants}`);
        console.log(`   - orders count: ${sampleSlot.orders.length}`);
        console.log(`   - overflow: ${sampleSlot.overflow}`);
        console.log(`   - isOverflow: ${sampleSlot.isOverflow}`);
        console.log(`   - status: ${sampleSlot.status}`);
      }
    }
    
    // Step 7: Additional cleanup - ensure all slots are properly reset
    console.log('🔄 Performing final slot reset...');
    
    let finalResetCount = 0;
    
    for (const plantSlot of updatedPlantSlots) {
      let plantSlotModified = false;
      
      for (const subtypeSlot of plantSlot.subtypeSlots) {
        for (const slot of subtypeSlot.slots) {
          // Ensure all booking-related fields are properly reset
          if (slot.totalBookedPlants !== 0 || slot.orders.length !== 0 || slot.overflow !== false || slot.isOverflow !== false) {
            slot.totalBookedPlants = 0;
            slot.orders = [];
            slot.overflow = false;
            slot.isOverflow = false;
            slot.status = false;
            plantSlotModified = true;
            finalResetCount++;
          }
        }
      }
      
      // Save the plant slot if it was modified
      if (plantSlotModified) {
        await plantSlot.save();
      }
    }
    
    console.log(`✅ Final reset completed for ${finalResetCount} slots`);
    
    // Step 8: Final verification
    console.log('🔍 Final verification...');
    
    const finalPlantSlots = await PlantSlot.find({});
    let finalOrderReferences = 0;
    let finalBookedPlants = 0;
    
    for (const plantSlot of finalPlantSlots) {
      for (const subtypeSlot of plantSlot.subtypeSlots) {
        for (const slot of subtypeSlot.slots) {
          if (slot.orders && slot.orders.length > 0) {
            finalOrderReferences += slot.orders.length;
          }
          if (slot.totalBookedPlants > 0) {
            finalBookedPlants += slot.totalBookedPlants;
          }
        }
      }
    }
    
    console.log(`📊 Final state:`);
    console.log(`   - Order references: ${finalOrderReferences}`);
    console.log(`   - Total booked plants: ${finalBookedPlants}`);
    console.log(`   - Orders in database: ${await Order.countDocuments()}`);
    
    if (finalOrderReferences === 0 && finalBookedPlants === 0) {
      console.log('✅ SUCCESS: All slot-order connections have been properly cleared!');
    } else {
      console.log('⚠️  WARNING: Some references may still exist');
    }
    
  } catch (error) {
    console.error('❌ Error during slot-order connection fix:', error);
  }
};

// Main execution
const main = async () => {
  console.log('🚀 Starting comprehensive slot-order connection fix...');
  
  await connectDB();
  await fixSlotOrderConnections();
  
  console.log('✅ Comprehensive fix completed');
  
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