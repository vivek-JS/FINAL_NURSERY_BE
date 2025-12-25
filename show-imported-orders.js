import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Order from './models/order.model.js';
import Farmer from './models/farmer.model.js';
import PlantCms from './models/plantCms.model.js';
import User from './models/user.model.js';
import Tray from './models/tray.model.js';

// Load environment variables
dotenv.config();

// Connect to database
const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI || process.env.DATABASE_URL;
    if (!uri) {
      throw new Error("MONGO_URL or MONGODB_URI environment variable is required.");
    }
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB\n');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

async function showOrders() {
  try {
    await connectDB();

    // Get the 10 most recently created orders (from our test import)
    const orders = await Order.find({})
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('farmer', 'name mobileNumber village taluka district')
      .populate('salesPerson', 'name phoneNumber')
      .populate('plantName', 'name')
      .populate('plantSubtype', 'name')
      .populate('reference', 'name phoneNumber')
      .populate('cavity', 'name cavity')
      .lean();

    console.log('='.repeat(80));
    console.log(`📊 SHOWING ${orders.length} MOST RECENT ORDERS`);
    console.log('='.repeat(80));
    console.log('');

    orders.forEach((order, index) => {
      console.log(`${index + 1}. Order ID: ${order.orderId}`);
      console.log(`   Farmer: ${order.farmer?.name || 'N/A'} (${order.farmer?.mobileNumber || 'N/A'})`);
      console.log(`   Location: ${order.farmer?.village || 'N/A'}, ${order.farmer?.taluka || 'N/A'}, ${order.farmer?.district || 'N/A'}`);
      console.log(`   Plant: ${order.plantName?.name || 'N/A'} - ${order.plantSubtype?.name || 'N/A'}`);
      console.log(`   Quantity: ${order.numberOfPlants} plants @ ₹${order.rate || 0} each`);
      console.log(`   Total Amount: ₹${(order.numberOfPlants * (order.rate || 0)).toLocaleString('en-IN')}`);
      console.log(`   Booking Date: ${order.orderBookingDate ? new Date(order.orderBookingDate).toLocaleDateString() : 'N/A'}`);
      console.log(`   Delivery Date: ${order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : 'N/A'}`);
      console.log(`   Old Delivery Date: ${order.oldDeliveryDate ? new Date(order.oldDeliveryDate).toLocaleDateString() : 'N/A'}`);
      console.log(`   Status: ${order.orderStatus || 'N/A'}`);
      console.log(`   Sales Person: ${order.salesPerson?.name || 'N/A'} (${order.salesPerson?.phoneNumber || 'N/A'})`);
      console.log(`   Reference: ${order.reference?.name || 'N/A'} ${order.reference?.phoneNumber ? `(${order.reference.phoneNumber})` : ''}`);
      console.log(`   Tray: ${order.cavity?.name || 'N/A'} (${order.cavity?.cavity || 'N/A'} cavity)`);
      console.log(`   Expected Nursery: ${order.expectedNursery || 'N/A'}`);
      
      if (order.payment && order.payment.length > 0) {
        console.log(`   Payments:`);
        order.payment.forEach((pay, i) => {
          console.log(`     ${i + 1}. ₹${pay.paidAmount || 0} - ${pay.paymentStatus || 'N/A'} - ${pay.modeOfPayment || 'N/A'}`);
          if (pay.bankName) console.log(`        Bank: ${pay.bankName}`);
          if (pay.chequeNumber) console.log(`        Cheque: ${pay.chequeNumber}`);
          console.log(`        Date: ${pay.paymentDate ? new Date(pay.paymentDate).toLocaleDateString() : 'N/A'}`);
        });
      }
      
      console.log(`   Payment Status: ${order.orderPaymentStatus || 'N/A'}`);
      console.log('');
      console.log('-'.repeat(80));
      console.log('');
    });

    console.log('='.repeat(80));
    console.log(`✅ Total Orders Shown: ${orders.length}`);
    console.log('='.repeat(80));

    process.exit(0);
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

showOrders();

