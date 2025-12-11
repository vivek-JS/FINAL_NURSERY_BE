import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Order from './models/order.model.js';

dotenv.config();

async function verifyTotalBookedCalculation() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/nursery');
    console.log('✅ Connected to MongoDB\n');

    const plantId = '68fdf6d45832d541b274ad09'; // Muskmelon

    // Test the exact aggregation pipeline used in the API
    const testSlotId = '6923004ddba45a54eba6f8e0'; // First slot from API response

    console.log('Testing aggregation for slot:', testSlotId);
    console.log('Plant ID:', plantId);
    console.log('---\n');

    // Check orders for this specific slot
    
    const ordersForSlot = await Order.find({
      bookingSlot: new mongoose.Types.ObjectId(testSlotId),
      orderStatus: { $nin: ['CANCELLED', 'REJECTED'] },
      $or: [
        { quotaSource: { $ne: 'dealer' } },
        { quotaSource: { $exists: false } }
      ]
    }).lean();

    console.log(`Orders found for slot ${testSlotId}: ${ordersForSlot.length}`);
    if (ordersForSlot.length > 0) {
      const total = ordersForSlot.reduce((sum, o) => sum + (o.numberOfPlants || 0), 0);
      console.log(`Total booked plants: ${total}`);
      console.log('Sample orders:');
      ordersForSlot.slice(0, 5).forEach((o, i) => {
        console.log(`  ${i+1}. Order ID: ${o._id}, Plants: ${o.numberOfPlants}, Status: ${o.orderStatus}, Quota: ${o.quotaSource || 'none'}`);
      });
    }

    // Test the exact lookup pipeline
    const lookupResult = await Order.aggregate([
      {
        $match: {
          bookingSlot: new mongoose.Types.ObjectId(testSlotId),
          orderStatus: { $nin: ['CANCELLED', 'REJECTED'] },
          $or: [
            { quotaSource: { $ne: 'dealer' } },
            { quotaSource: { $exists: false } }
          ]
        }
      },
      {
        $group: {
          _id: null,
          totalBookedPlants: { $sum: '$numberOfPlants' }
        }
      }
    ]);

    console.log('\n---');
    console.log('Aggregation result:', lookupResult);
    const calculatedTotal = lookupResult.length > 0 ? lookupResult[0].totalBookedPlants : 0;
    console.log(`Calculated totalBookedPlants: ${calculatedTotal}`);

    // Check all orders for Muskmelon
    console.log('\n---');
    console.log('Checking all orders for Muskmelon plant...');
    const allMuskmelonOrders = await Order.find({
      plant: new mongoose.Types.ObjectId(plantId),
      orderStatus: { $nin: ['CANCELLED', 'REJECTED'] },
      $or: [
        { quotaSource: { $ne: 'dealer' } },
        { quotaSource: { $exists: false } }
      ]
    }).lean();

    console.log(`Total orders for Muskmelon: ${allMuskmelonOrders.length}`);
    if (allMuskmelonOrders.length > 0) {
      const grandTotal = allMuskmelonOrders.reduce((sum, o) => sum + (o.numberOfPlants || 0), 0);
      console.log(`Grand total booked plants: ${grandTotal}`);
      
      // Group by slot
      const bySlot = {};
      allMuskmelonOrders.forEach(o => {
        const slotId = o.bookingSlot?.toString() || 'null';
        if (!bySlot[slotId]) {
          bySlot[slotId] = 0;
        }
        bySlot[slotId] += o.numberOfPlants || 0;
      });
      
      console.log(`\nOrders across ${Object.keys(bySlot).length} slots`);
      const topSlots = Object.entries(bySlot)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      
      console.log('\nTop 10 slots by booked plants:');
      topSlots.forEach(([slotId, total]) => {
        console.log(`  Slot ${slotId.substring(0, 8)}...: ${total} plants`);
      });
    } else {
      console.log('⚠️  No orders found for Muskmelon. If you expect 73500 booked plants, orders need to be imported.');
    }

    await mongoose.disconnect();
    console.log('\n✅ Done');
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

verifyTotalBookedCalculation();

