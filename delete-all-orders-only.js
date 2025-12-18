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
    
    // Import all order models
    const Order = (await import('./models/order.model.js')).default;
    const DealerOrder = (await import('./models/dealerOrder.model.js')).default;
    const SellOrder = (await import('./models/sellOrder.model.js')).default;
    
    console.log('\n📊 Counting orders before deletion...\n');
    
    // Count orders before deletion
    const ordersCount = await Order.countDocuments({});
    const dealerOrdersCount = await DealerOrder.countDocuments({});
    const sellOrdersCount = await SellOrder.countDocuments({});
    const totalCount = ordersCount + dealerOrdersCount + sellOrdersCount;
    
    console.log(`📦 Regular Orders (Order): ${ordersCount} documents`);
    console.log(`📦 Dealer Orders (DealerOrder): ${dealerOrdersCount} documents`);
    console.log(`📦 Sell Orders (SellOrder): ${sellOrdersCount} documents`);
    console.log(`📦 Total Orders: ${totalCount} documents\n`);
    
    if (totalCount === 0) {
      console.log('ℹ️  No orders found. Nothing to delete.');
      await mongoose.connection.close();
      return;
    }
    
    console.log('🗑️  Deleting ALL orders (ONLY orders, nothing else)...\n');
    
    // Delete all orders from each collection
    const ordersResult = await Order.deleteMany({});
    console.log(`✅ Regular Orders: Deleted ${ordersResult.deletedCount} documents`);
    
    const dealerOrdersResult = await DealerOrder.deleteMany({});
    console.log(`✅ Dealer Orders: Deleted ${dealerOrdersResult.deletedCount} documents`);
    
    const sellOrdersResult = await SellOrder.deleteMany({});
    console.log(`✅ Sell Orders: Deleted ${sellOrdersResult.deletedCount} documents`);
    
    const totalDeleted = ordersResult.deletedCount + dealerOrdersResult.deletedCount + sellOrdersResult.deletedCount;
    
    console.log(`\n✅ Total deleted: ${totalDeleted} order documents`);
    console.log('✅ All orders deleted successfully! (No other data was affected)\n');
    
    // Verify deletion
    console.log('🔍 Verifying deletion...\n');
    const remainingOrders = await Order.countDocuments({});
    const remainingDealerOrders = await DealerOrder.countDocuments({});
    const remainingSellOrders = await SellOrder.countDocuments({});
    
    if (remainingOrders === 0 && remainingDealerOrders === 0 && remainingSellOrders === 0) {
      console.log('✅ Verification successful: All orders have been deleted.');
    } else {
      console.log(`⚠️  Warning: Some orders may still exist:`);
      console.log(`   - Regular Orders: ${remainingOrders}`);
      console.log(`   - Dealer Orders: ${remainingDealerOrders}`);
      console.log(`   - Sell Orders: ${remainingSellOrders}`);
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

deleteAllOrders();



