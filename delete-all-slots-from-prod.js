/**
 * Delete ALL PlantSlot documents from production database.
 *
 * USAGE:
 *   1. Set MONGO_URL to your PRODUCTION MongoDB URI
 *   2. Run: node delete-all-slots-from-prod.js
 *
 * WARNING: This permanently deletes ALL slots. Orders will have orphaned bookingSlot IDs.
 * For full data clear (orders + slots + sowing + etc), use clear-orders-slots-sowing.js
 */

import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

const connectDB = async () => {
  try {
    const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL || process.env.MONGODB_URI;
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

const deleteAllSlots = async () => {
  try {
    await connectDB();

    const PlantSlot = (await import('./models/slots.model.js')).default;
    const Order = (await import('./models/order.model.js')).default;

    console.log('\n🗑️  Delete ALL Slots from Production');
    console.log('═══════════════════════════════════════════════════════════\n');

    const countBefore = await PlantSlot.countDocuments();
    console.log(`📊 PlantSlot documents to delete: ${countBefore}\n`);

    if (countBefore === 0) {
      console.log('ℹ️  No PlantSlot documents found. Nothing to delete.');
      return;
    }

    const ordersWithSlot = await Order.countDocuments({ bookingSlot: { $exists: true, $ne: null } });
    if (ordersWithSlot > 0) {
      console.log(`⚠️  WARNING: ${ordersWithSlot} order(s) reference slots. They will have orphaned bookingSlot IDs.\n`);
    }

    const result = await PlantSlot.deleteMany({});

    console.log('✅ Deletion complete:');
    console.log(`   Deleted ${result.deletedCount} PlantSlot document(s)\n`);

    console.log('═══════════════════════════════════════════════════════════');
    console.log('✅ All slots deleted successfully');
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

deleteAllSlots();
