import mongoose from 'mongoose';
import Order from './models/order.model.js';
import Farmer from './models/farmer.model.js';
import User from './models/user.model.js';
import dotenv from 'dotenv';

dotenv.config();

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URL || 'mongodb://localhost:27017/nursery')
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

async function findOrdersWithFarmerDealerSameName() {
  try {
    console.log('🔍 Searching for orders where farmer name matches dealer name...\n');

    // Aggregate pipeline to find orders where farmer name = dealer name
    const orders = await Order.aggregate([
      {
        $lookup: {
          from: 'farmers',
          localField: 'farmer',
          foreignField: '_id',
          as: 'farmerData'
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'dealer',
          foreignField: '_id',
          as: 'dealerData'
        }
      },
      {
        $unwind: {
          path: '$farmerData',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $unwind: {
          path: '$dealerData',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $match: {
          $and: [
            { farmerData: { $exists: true } },
            { dealerData: { $exists: true } },
            { $expr: { $eq: ['$farmerData.name', '$dealerData.name'] } }
          ]
        }
      },
      {
        $project: {
          orderId: 1,
          orderStatus: 1,
          numberOfPlants: 1,
          rate: 1,
          createdAt: 1,
          farmerName: '$farmerData.name',
          dealerName: '$dealerData.name',
          farmerPhone: '$farmerData.mobileNumber',
          dealerPhone: '$dealerData.phoneNumber',
          salesPerson: 1,
          plantName: 1,
          plantSubtype: 1,
          orderPaymentStatus: 1,
          paymentCompleted: 1
        }
      },
      {
        $sort: { createdAt: -1 }
      }
    ]);

    if (orders.length === 0) {
      console.log('❌ No orders found where farmer name matches dealer name.');
      return;
    }

    console.log(`✅ Found ${orders.length} order(s) where farmer name matches dealer name:\n`);

    orders.forEach((order, index) => {
      console.log(`📋 Order #${index + 1}:`);
      console.log(`   Order ID: ${order.orderId}`);
      console.log(`   Status: ${order.orderStatus}`);
      console.log(`   Farmer/Dealer Name: ${order.farmerName}`);
      console.log(`   Farmer Phone: ${order.farmerPhone || 'N/A'}`);
      console.log(`   Dealer Phone: ${order.dealerPhone || 'N/A'}`);
      console.log(`   Plants: ${order.numberOfPlants}`);
      console.log(`   Rate: ₹${order.rate}`);
      console.log(`   Total: ₹${order.numberOfPlants * order.rate}`);
      console.log(`   Payment Status: ${order.orderPaymentStatus}`);
      console.log(`   Payment Completed: ${order.paymentCompleted}`);
      console.log(`   Created: ${new Date(order.createdAt).toLocaleDateString()}`);
      console.log('   ' + '─'.repeat(50));
    });

    // Summary statistics
    const totalValue = orders.reduce((sum, order) => sum + (order.numberOfPlants * order.rate), 0);
    const statusCounts = orders.reduce((acc, order) => {
      acc[order.orderStatus] = (acc[order.orderStatus] || 0) + 1;
      return acc;
    }, {});

    console.log('\n📊 Summary:');
    console.log(`   Total Orders: ${orders.length}`);
    console.log(`   Total Value: ₹${totalValue.toLocaleString()}`);
    console.log('   Status Breakdown:');
    Object.entries(statusCounts).forEach(([status, count]) => {
      console.log(`     ${status}: ${count}`);
    });

  } catch (error) {
    console.error('❌ Error finding orders:', error);
  } finally {
    mongoose.connection.close();
    console.log('\n🔌 Database connection closed.');
  }
}

// Run the function
findOrdersWithFarmerDealerSameName(); 