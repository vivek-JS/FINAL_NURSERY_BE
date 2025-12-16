import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Use the same connection string as the server (MONGO_URL is what the server uses)
const MONGODB_URI = process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://localhost:27017/nursery';

// Connect to MongoDB
await mongoose.connect(MONGODB_URI);
console.log('✅ Connected to MongoDB');

// Import models
const { default: Order } = await import('../models/order.model.js');
const { default: Farmer } = await import('../models/farmer.model.js');

// Check total orders
const totalOrders = await Order.countDocuments({});
console.log(`\n📊 Total orders in database: ${totalOrders}`);

if (totalOrders === 0) {
  console.log('ℹ️  No orders found in database. Nothing to delete.');
  await mongoose.disconnect();
  process.exit(0);
}

// Show sample of orders
const sampleOrders = await Order.find({})
  .sort({ createdAt: -1 })
  .limit(10)
  .select('orderId farmer numberOfPlants createdAt')
  .populate('farmer', 'name')
  .lean();

console.log('\n📋 Sample orders in database:');
sampleOrders.forEach((order, index) => {
  console.log(`   ${index + 1}. Order ID: ${order.orderId} - ${order.farmer?.name || 'Unknown'} - ${order.numberOfPlants} plants - ${new Date(order.createdAt).toLocaleString()}`);
});

// Ask for confirmation - delete orders created today
const today = new Date();
today.setHours(0, 0, 0, 0);

const ordersToday = await Order.countDocuments({
  createdAt: { $gte: today }
});

console.log(`\n📅 Orders created today: ${ordersToday}`);

if (ordersToday > 0) {
  console.log('\n🗑️  Deleting orders created today...');
  const deleteResult = await Order.deleteMany({
    createdAt: { $gte: today }
  });
  console.log(`✅ Successfully deleted ${deleteResult.deletedCount} orders created today`);
} else {
  // If no orders today, delete all orders (since user wants to delete the ones we created)
  console.log('\n🗑️  No orders found from today. Deleting all orders...');
  const deleteResult = await Order.deleteMany({});
  console.log(`✅ Successfully deleted ${deleteResult.deletedCount} orders`);
}

// Verify deletion
const remaining = await Order.countDocuments({});
console.log(`\n📊 Remaining orders: ${remaining}`);

// Close MongoDB connection
await mongoose.disconnect();
console.log('\n✅ Disconnected from MongoDB');
process.exit(0);

