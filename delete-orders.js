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

const deleteAllOrders = async () => {
  try {
    await connectDB();
    
    const Order = (await import('./models/order.model.js')).default;
    const DealerOrder = (await import('./models/dealerOrder.model.js')).default;
    
    console.log('\n📊 Counting orders before deletion...\n');
    
    // Count orders before deletion
    const ordersCount = await Order.countDocuments({});
    const dealerOrdersCount = await DealerOrder.countDocuments({});
    
    console.log(`📦 Regular Orders: ${ordersCount} documents`);
    console.log(`📦 Dealer Orders: ${dealerOrdersCount} documents`);
    console.log(`📦 Total Orders: ${ordersCount + dealerOrdersCount} documents\n`);
    
    if (ordersCount === 0 && dealerOrdersCount === 0) {
      console.log('ℹ️  No orders found. Nothing to delete.');
      await mongoose.connection.close();
      return;
    }
    
    console.log('🗑️  Deleting all orders (ONLY orders, nothing else)...\n');
    
    // Delete all orders
    const ordersResult = await Order.deleteMany({});
    console.log(`✅ Regular Orders: Deleted ${ordersResult.deletedCount} documents`);
    
    const dealerOrdersResult = await DealerOrder.deleteMany({});
    console.log(`✅ Dealer Orders: Deleted ${dealerOrdersResult.deletedCount} documents`);
    
    const totalDeleted = ordersResult.deletedCount + dealerOrdersResult.deletedCount;
    console.log(`\n✅ Total deleted: ${totalDeleted} order documents`);
    console.log('✅ All orders deleted successfully! (No other data was affected)\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  }
};

deleteAllOrders();





