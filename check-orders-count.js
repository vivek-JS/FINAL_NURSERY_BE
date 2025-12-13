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

const checkOrders = async () => {
  try {
    await connectDB();
    
    const Order = (await import('./models/order.model.js')).default;
    const DealerOrder = (await import('./models/dealerOrder.model.js')).default;
    
    console.log('\n📊 Checking orders in database...\n');
    
    const ordersCount = await Order.countDocuments({});
    const dealerOrdersCount = await DealerOrder.countDocuments({});
    
    console.log(`📦 Regular Orders: ${ordersCount}`);
    console.log(`📦 Dealer Orders: ${dealerOrdersCount}`);
    console.log(`📦 Total Orders: ${ordersCount + dealerOrdersCount}\n`);
    
    if (ordersCount > 0) {
      console.log('⚠️  Found orders! These are causing the pendingQuantity in sowing alerts.\n');
      console.log('Sample orders:');
      const sampleOrders = await Order.find({}).limit(5).select('orderId numberOfPlants bookingSlot orderStatus plantName subtypeName');
      sampleOrders.forEach(order => {
        console.log(`  - Order ${order.orderId}: ${order.numberOfPlants} plants, Status: ${order.orderStatus}`);
        console.log(`    Plant: ${order.plantName}, Subtype: ${order.subtypeName}`);
        console.log(`    BookingSlot: ${order.bookingSlot}`);
      });
    }
    
    if (dealerOrdersCount > 0) {
      console.log('\nSample dealer orders:');
      const sampleDealerOrders = await DealerOrder.find({}).limit(5).select('orderId numberOfPlants bookingSlots orderStatus');
      sampleDealerOrders.forEach(order => {
        console.log(`  - Dealer Order ${order.orderId}: ${order.numberOfPlants} plants, Status: ${order.orderStatus}`);
      });
    }
    
    if (ordersCount === 0 && dealerOrdersCount === 0) {
      console.log('✅ No orders found. The pendingQuantity should be 0 if primarySowed is also 0.');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

checkOrders();




