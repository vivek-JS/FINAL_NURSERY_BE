import mongoose from 'mongoose';
import Order from './models/order.model.js';
import { calculateSlotBookedPlants } from './utility/slotBookedPlantsCalculator.js';

// Test function to verify order cancellation behavior
const testOrderCancellation = async () => {
  try {
    console.log('🧪 Testing order cancellation and slot calculation...');
    
    // Connect to database
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/nursery');
    console.log('✅ Connected to database');
    
    // Find a slot with orders
    const orderWithSlot = await Order.findOne({
      orderStatus: { $nin: ['CANCELLED', 'REJECTED'] }
    }).populate('bookingSlot');
    
    if (!orderWithSlot) {
      console.log('❌ No active orders found for testing');
      return;
    }
    
    const slotId = orderWithSlot.bookingSlot;
    const orderId = orderWithSlot._id;
    const numberOfPlants = orderWithSlot.numberOfPlants;
    
    console.log(`📋 Found order ${orderId} with ${numberOfPlants} plants for slot ${slotId}`);
    
    // Calculate booked plants before cancellation
    const bookedPlantsBefore = await calculateSlotBookedPlants(slotId);
    console.log(`📊 Booked plants before cancellation: ${bookedPlantsBefore}`);
    
    // Cancel the order
    await Order.findByIdAndUpdate(orderId, { orderStatus: 'CANCELLED' });
    console.log(`❌ Cancelled order ${orderId}`);
    
    // Calculate booked plants after cancellation
    const bookedPlantsAfter = await calculateSlotBookedPlants(slotId);
    console.log(`📊 Booked plants after cancellation: ${bookedPlantsAfter}`);
    
    // Verify the difference
    const difference = bookedPlantsBefore - bookedPlantsAfter;
    console.log(`📈 Plants freed up: ${difference}`);
    
    if (difference === numberOfPlants) {
      console.log('✅ SUCCESS: Order cancellation properly freed up plants in slot calculation');
    } else {
      console.log('❌ FAILED: Order cancellation did not properly update slot calculation');
    }
    
    // Test rejected orders too
    const orderToReject = await Order.findOne({
      orderStatus: { $nin: ['CANCELLED', 'REJECTED'] }
    });
    
    if (orderToReject) {
      const rejectSlotId = orderToReject.bookingSlot;
      const rejectOrderId = orderToReject._id;
      const rejectNumberOfPlants = orderToReject.numberOfPlants;
      
      console.log(`\n📋 Testing rejection for order ${rejectOrderId} with ${rejectNumberOfPlants} plants`);
      
      const bookedPlantsBeforeReject = await calculateSlotBookedPlants(rejectSlotId);
      console.log(`📊 Booked plants before rejection: ${bookedPlantsBeforeReject}`);
      
      await Order.findByIdAndUpdate(rejectOrderId, { orderStatus: 'REJECTED' });
      console.log(`❌ Rejected order ${rejectOrderId}`);
      
      const bookedPlantsAfterReject = await calculateSlotBookedPlants(rejectSlotId);
      console.log(`📊 Booked plants after rejection: ${bookedPlantsAfterReject}`);
      
      const rejectDifference = bookedPlantsBeforeReject - bookedPlantsAfterReject;
      console.log(`📈 Plants freed up: ${rejectDifference}`);
      
      if (rejectDifference === rejectNumberOfPlants) {
        console.log('✅ SUCCESS: Order rejection properly freed up plants in slot calculation');
      } else {
        console.log('❌ FAILED: Order rejection did not properly update slot calculation');
      }
    }
    
    console.log('\n🎉 Order cancellation/rejection test completed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from database');
  }
};

// Run the test
testOrderCancellation(); 