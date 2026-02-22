/**
 * Delete all generated slots for Banana from production database.
 *
 * USAGE:
 *   1. Set MONGO_URL to your PRODUCTION MongoDB URI
 *   2. Run: node delete-banana-slots-from-prod.js
 *
 * WARNING: This permanently deletes PlantSlot documents for Banana.
 * Orders that reference these slots will have orphaned bookingSlot IDs.
 */

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

const deleteBananaSlots = async () => {
  try {
    await connectDB();

    const PlantCms = (await import('./models/plantCms.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    const Order = (await import('./models/order.model.js')).default;

    console.log('\n🍌 Delete Banana Slots from Production');
    console.log('═══════════════════════════════════════════════════════════\n');

    // Find Banana plant (case-insensitive: Banana, banana, Keli, etc.)
    const bananaPlant = await PlantCms.findOne({
      $or: [
        { name: { $regex: new RegExp('^banana$', 'i') } },
        { name: { $regex: new RegExp('^keli$', 'i') } },
      ],
    });

    if (!bananaPlant) {
      console.log('❌ Banana plant not found in database');
      return;
    }

    console.log(`✅ Found plant: ${bananaPlant.name} (${bananaPlant._id})\n`);

    // Get all PlantSlot documents for Banana
    const bananaSlots = await PlantSlot.find({ plantId: bananaPlant._id });

    if (bananaSlots.length === 0) {
      console.log('ℹ️  No PlantSlot documents found for Banana. Nothing to delete.');
      return;
    }

    // Collect all slot IDs (nested in subtypeSlots.slots)
    const slotIds = [];
    for (const ps of bananaSlots) {
      for (const st of ps.subtypeSlots || []) {
        for (const slot of st.slots || []) {
          if (slot._id) slotIds.push(slot._id);
        }
      }
    }

    // Count orders that reference these slots
    const ordersCount = await Order.countDocuments({
      bookingSlot: { $in: slotIds },
      orderStatus: { $nin: ['CANCELLED', 'REJECTED'] },
    });

    const totalOrdersCount = await Order.countDocuments({
      bookingSlot: { $in: slotIds },
    });

    console.log('📊 Summary before deletion:');
    console.log(`   PlantSlot documents to delete: ${bananaSlots.length}`);
    console.log(`   Total slot entries: ${slotIds.length}`);
    console.log(`   Orders referencing these slots (active): ${ordersCount}`);
    console.log(`   Orders referencing these slots (all): ${totalOrdersCount}\n`);

    if (ordersCount > 0) {
      console.log('⚠️  WARNING: There are active orders linked to these slots.');
      console.log('   Deleting slots will orphan those orders (bookingSlot will reference non-existent slots).');
      console.log('   Consider cancelling/rejecting those orders first, or handle them manually.\n');
    }

    // Delete PlantSlot documents for Banana
    const result = await PlantSlot.deleteMany({ plantId: bananaPlant._id });

    console.log('✅ Deletion complete:');
    console.log(`   Deleted ${result.deletedCount} PlantSlot document(s) for Banana\n`);

    console.log('═══════════════════════════════════════════════════════════');
    console.log('✅ Banana slots deleted successfully');
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

deleteBananaSlots();
