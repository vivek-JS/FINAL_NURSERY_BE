import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/nursery';

// Connect to MongoDB
await mongoose.connect(MONGODB_URI);
console.log('✅ Connected to MongoDB');

// Import Order model
const { default: Order } = await import('../models/order.model.js');

// Delete orders created today (to catch all the orders we just created)
const today = new Date();
today.setHours(0, 0, 0, 0);

console.log('\n🗑️  Deleting orders created after:', today.toISOString());

// Find orders to delete
const ordersToDelete = await Order.find({
  createdAt: { $gte: today }
}).select('_id orderId farmer.name numberOfPlants createdAt').lean();

console.log(`📊 Found ${ordersToDelete.length} orders to delete`);

if (ordersToDelete.length === 0) {
  console.log('ℹ️  No recent orders found to delete.');
  await mongoose.disconnect();
  process.exit(0);
}

// Show sample of orders to be deleted
console.log('\n📋 Sample orders to be deleted:');
ordersToDelete.slice(0, 5).forEach((order, index) => {
  console.log(`   ${index + 1}. Order ID: ${order.orderId} - ${order.farmer?.name || 'Unknown'} - ${order.numberOfPlants} plants - ${new Date(order.createdAt).toLocaleString()}`);
});
if (ordersToDelete.length > 5) {
  console.log(`   ... and ${ordersToDelete.length - 5} more orders`);
}

// Delete the orders
console.log('\n🗑️  Deleting orders...');
const deleteResult = await Order.deleteMany({
  createdAt: { $gte: twoHoursAgo }
});

console.log(`\n✅ Successfully deleted ${deleteResult.deletedCount} orders`);

// Verify deletion
const remaining = await Order.countDocuments({
  createdAt: { $gte: twoHoursAgo }
});
console.log(`📊 Remaining orders in time range: ${remaining}`);

// Close MongoDB connection
await mongoose.disconnect();
console.log('\n✅ Disconnected from MongoDB');
process.exit(0);

