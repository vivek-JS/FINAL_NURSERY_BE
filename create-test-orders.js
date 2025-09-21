import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Order from './models/order.model.js';
import User from './models/user.model.js';

dotenv.config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ Connected to database');
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    process.exit(1);
  }
};

const createTestOrders = async () => {
  try {
    await connectDB();

    console.log('🔍 Creating test orders for role-based filtering...');

    // Get user IDs
    const salesUser = await User.findOne({ phoneNumber: 9876543210 });
    const dealerUser = await User.findOne({ phoneNumber: 9999999999 });
    const adminUser = await User.findOne({ phoneNumber: 7588686452 });

    if (!salesUser || !dealerUser || !adminUser) {
      console.log('❌ Required users not found. Please create test users first.');
      return;
    }

    console.log('👥 Found users:');
    console.log(`   SALES: ${salesUser.name} (${salesUser._id})`);
    console.log(`   DEALER: ${dealerUser.name} (${dealerUser._id})`);
    console.log(`   ADMIN: ${adminUser.name} (${adminUser._id})`);

    // Create test orders
    const testOrders = [
      {
        orderId: 1001,
        dealerOrder: false,
        farmer: new mongoose.Types.ObjectId(), // Required for non-dealer orders
        salesPerson: salesUser._id,
        numberOfPlants: 100,
        remainingPlants: 100,
        plantName: new mongoose.Types.ObjectId(),
        plantSubtype: new mongoose.Types.ObjectId(),
        bookingSlot: new mongoose.Types.ObjectId(),
        cavity: new mongoose.Types.ObjectId(),
        rate: 25,
        orderPaymentStatus: "PENDING",
        orderStatus: "ACCEPTED",
        orderBookingDate: new Date(),
        payment: []
      },
      {
        orderId: 1002,
        dealerOrder: true,
        dealer: dealerUser._id,
        salesPerson: dealerUser._id,
        numberOfPlants: 200,
        remainingPlants: 200,
        plantName: new mongoose.Types.ObjectId(),
        plantSubtype: new mongoose.Types.ObjectId(),
        bookingSlot: new mongoose.Types.ObjectId(),
        cavity: new mongoose.Types.ObjectId(),
        rate: 30,
        orderPaymentStatus: "PENDING",
        orderStatus: "ACCEPTED",
        orderBookingDate: new Date(),
        payment: []
      },
      {
        orderId: 1003,
        dealerOrder: false,
        farmer: new mongoose.Types.ObjectId(), // Required for non-dealer orders
        salesPerson: salesUser._id,
        numberOfPlants: 150,
        remainingPlants: 150,
        plantName: new mongoose.Types.ObjectId(),
        plantSubtype: new mongoose.Types.ObjectId(),
        bookingSlot: new mongoose.Types.ObjectId(),
        cavity: new mongoose.Types.ObjectId(),
        rate: 20,
        orderPaymentStatus: "PENDING",
        orderStatus: "PENDING",
        orderBookingDate: new Date(),
        payment: []
      },
      {
        orderId: 1004,
        dealerOrder: true,
        dealer: dealerUser._id,
        salesPerson: dealerUser._id,
        numberOfPlants: 300,
        remainingPlants: 300,
        plantName: new mongoose.Types.ObjectId(),
        plantSubtype: new mongoose.Types.ObjectId(),
        bookingSlot: new mongoose.Types.ObjectId(),
        cavity: new mongoose.Types.ObjectId(),
        rate: 35,
        orderPaymentStatus: "PENDING",
        orderStatus: "DISPATCHED",
        orderBookingDate: new Date(),
        payment: []
      }
    ];

    // Clear existing test orders
    await Order.deleteMany({ orderId: { $in: [1001, 1002, 1003, 1004] } });
    console.log('🧹 Cleared existing test orders');

    // Create new test orders
    for (const orderData of testOrders) {
      const order = new Order(orderData);
      await order.save();
      console.log(`✅ Created order ${orderData.orderId} - ${orderData.dealerOrder ? 'DEALER' : 'SALES'} order`);
    }

    console.log('\n🎯 Test orders created successfully!');
    console.log('📊 Order Summary:');
    console.log('   Order 1001: SALES order (assigned to sales user)');
    console.log('   Order 1002: DEALER order (assigned to dealer user)');
    console.log('   Order 1003: SALES order (assigned to sales user)');
    console.log('   Order 1004: DEALER order (assigned to dealer user)');
    console.log('\n🔍 Expected filtering behavior:');
    console.log('   • SALES user should see orders 1001 and 1003');
    console.log('   • DEALER user should see orders 1002 and 1004');
    console.log('   • ADMIN user should see all orders (1001, 1002, 1003, 1004)');

  } catch (error) {
    console.error('❌ Error creating test orders:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from database');
  }
};

// Run the function
createTestOrders();
