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
    
    console.log('\n🗑️ Deleting all orders...\n');
    
    const ordersResult = await Order.deleteMany({});
    console.log(`✅ Orders: Deleted ${ordersResult.deletedCount} documents`);
    
    const dealerOrdersResult = await DealerOrder.deleteMany({});
    console.log(`✅ Dealer Orders: Deleted ${dealerOrdersResult.deletedCount} documents`);
    
    console.log('\n✅ All orders cleaned successfully!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.connection.close();
  }
};

deleteAllOrders();





