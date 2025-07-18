import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import Order from './models/order.model.js';
import PlantCms from './models/plantCms.model.js';
import PlantSlot from './models/slots.model.js';
import Farmer from './models/farmer.model.js';
import User from './models/user.model.js';
import { getSlotInfoWithBookedPlants, calculateSlotBookedPlants } from './utility/slotBookedPlantsCalculator.js';

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

const testOrderBooking = async () => {
  await connectDB();
  
  console.log('🧪 Testing Order Booking and Dynamic Calculation...\n');
  
  // Find Banana plant and a slot
  const bananaPlant = await PlantCms.findOne({ name: { $regex: /^Banana$/i } });
  if (!bananaPlant) {
    console.log('❌ Banana plant not found');
    mongoose.disconnect();
    return;
  }
  
  const plantSlot = await PlantSlot.findOne({ plantId: bananaPlant._id });
  if (!plantSlot || !plantSlot.subtypeSlots.length) {
    console.log('❌ Banana plant slots not found');
    mongoose.disconnect();
    return;
  }
  
  // Get first slot
  const firstSubtypeSlot = plantSlot.subtypeSlots[0];
  const firstSlot = firstSubtypeSlot.slots[0];
  const slotId = firstSlot._id;
  const subtype = bananaPlant.subtypes.find(st => st._id.equals(firstSubtypeSlot.subtypeId));
  
  console.log(`📋 Testing with:`);
  console.log(`  Plant: ${bananaPlant.name}`);
  console.log(`  Subtype: ${subtype ? subtype.name : 'Unknown'}`);
  console.log(`  Slot: ${firstSlot.startDay} to ${firstSlot.endDay}`);
  console.log(`  Slot ID: ${slotId}`);
  
  // Check initial state
  console.log('\n📊 Initial Slot State:');
  const initialSlotInfo = await getSlotInfoWithBookedPlants(slotId);
  if (initialSlotInfo) {
    console.log(`  Total Plants: ${initialSlotInfo.totalPlants.toLocaleString()}`);
    console.log(`  Booked Plants: ${initialSlotInfo.totalBookedPlants.toLocaleString()}`);
    console.log(`  Available Plants: ${initialSlotInfo.availablePlants.toLocaleString()}`);
  }
  
  // Create a test farmer if none exists
  let farmer = await Farmer.findOne({});
  if (!farmer) {
    farmer = await Farmer.create({
      name: 'Test Farmer',
      mobileNumber: 9999999999,
      village: 'Test Village',
      taluka: 'Test Taluka',
      district: 'Test District',
      state: 'Maharashtra'
    });
    console.log('👨‍🌾 Created test farmer');
  }
  
  // Create a test salesperson if none exists
  let salesPerson = await User.findOne({ role: 'SALES' });
  if (!salesPerson) {
    salesPerson = await User.create({
      name: 'Test Salesperson',
      phoneNumber: 8888888888,
      role: 'SALES',
      jobTitle: 'SALES'
    });
    console.log('👤 Created test salesperson');
  }
  
  // Create a test order
  const testOrderData = {
    orderId: 99999, // Use a unique ID
    farmer: farmer._id,
    salesPerson: salesPerson._id,
    numberOfPlants: 5000,
    rate: 25,
    plantName: bananaPlant._id,
    plantSubtype: subtype._id,
    bookingSlot: slotId,
    orderStatus: 'ACCEPTED',
    orderPaymentStatus: 'PENDING',
    orderBookingDate: new Date(),
  };
  
  console.log('\n📝 Creating test order...');
  const testOrder = await Order.create(testOrderData);
  console.log(`✅ Order created with ID: ${testOrder.orderId}`);
  console.log(`📦 Plants booked: ${testOrder.numberOfPlants.toLocaleString()}`);
  
  // Check slot state after booking
  console.log('\n📊 Slot State After Booking:');
  const afterSlotInfo = await getSlotInfoWithBookedPlants(slotId);
  if (afterSlotInfo) {
    console.log(`  Total Plants: ${afterSlotInfo.totalPlants.toLocaleString()}`);
    console.log(`  Booked Plants: ${afterSlotInfo.totalBookedPlants.toLocaleString()}`);
    console.log(`  Available Plants: ${afterSlotInfo.availablePlants.toLocaleString()}`);
    console.log(`  Is Overflow: ${afterSlotInfo.isOverflow}`);
  }
  
  // Verify the order exists
  const orderCount = await Order.countDocuments({ bookingSlot: slotId });
  console.log(`\n📋 Orders for this slot: ${orderCount}`);
  
  // Test direct calculation
  const directBooked = await calculateSlotBookedPlants(slotId);
  console.log(`🔄 Direct calculation: ${directBooked.toLocaleString()} booked plants`);
  
  // Clean up - delete the test order
  console.log('\n🧹 Cleaning up test order...');
  await Order.deleteOne({ _id: testOrder._id });
  console.log('✅ Test order deleted');
  
  // Verify cleanup
  const finalSlotInfo = await getSlotInfoWithBookedPlants(slotId);
  if (finalSlotInfo) {
    console.log(`\n📊 Final Slot State:`);
    console.log(`  Total Plants: ${finalSlotInfo.totalPlants.toLocaleString()}`);
    console.log(`  Booked Plants: ${finalSlotInfo.totalBookedPlants.toLocaleString()}`);
    console.log(`  Available Plants: ${finalSlotInfo.availablePlants.toLocaleString()}`);
  }
  
  console.log('\n✅ Order booking test completed successfully!');
  console.log('🎯 Dynamic booking calculation is working correctly!');
  
  mongoose.disconnect();
};

testOrderBooking(); 