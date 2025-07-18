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

// Delete all orders
const deleteAllOrders = async () => {
  try {
    // Import the Order model
    const { default: Order } = await import('./models/order.model.js');
    
    // Count orders before deletion
    const orderCount = await Order.countDocuments();
    console.log(`📊 Found ${orderCount} orders to delete`);
    
    if (orderCount === 0) {
      console.log('✅ No orders found to delete');
      return;
    }
    
    // Delete all orders
    const result = await Order.deleteMany({});
    
    console.log(`✅ Successfully deleted ${result.deletedCount} orders`);
    
    // Verify deletion
    const remainingOrders = await Order.countDocuments();
    console.log(`📊 Remaining orders: ${remainingOrders}`);
    
  } catch (error) {
    console.error('❌ Error deleting orders:', error);
  }
};

// Main execution
const main = async () => {
  console.log('🚀 Starting order deletion process...');
  
  await connectDB();
  await deleteAllOrders();
  
  console.log('✅ Order deletion process completed');
  
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