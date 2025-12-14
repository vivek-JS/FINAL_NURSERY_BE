import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGO_URL or MONGODB_URI environment variable is required.');
    }
    await mongoose.connect(uri);
    console.log('✅ MongoDB Connected');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

const fixRemindersAfterClear = async () => {
  try {
    const { default: Order } = await import('./models/order.model.js');
    const { default: PlantSlot } = await import('./models/slots.model.js');
    const { default: Sowing } = await import('./models/sowing.model.js');

    await connectDB();

    console.log('\n🔍 Checking reminders data...\n');

    // Step 1: Check order count
    const orderCount = await Order.countDocuments({});
    console.log(`📊 Orders count: ${orderCount}`);

    // Step 2: Check slot count
    const slotCount = await PlantSlot.countDocuments({});
    console.log(`📊 Plant Slots count: ${slotCount}`);

    // Step 3: Check if slots have any booking data
    const plantSlots = await PlantSlot.find({});
    let slotsWithBookings = 0;
    let slotsWithOrders = 0;
    let totalSlots = 0;

    for (const plantSlot of plantSlots) {
      for (const subtypeSlot of plantSlot.subtypeSlots || []) {
        for (const slot of subtypeSlot.slots || []) {
          totalSlots++;
          if (slot.totalBookedPlants > 0) {
            slotsWithBookings++;
          }
          if (slot.orders && slot.orders.length > 0) {
            slotsWithOrders++;
          }
        }
      }
    }

    console.log(`📊 Total slots: ${totalSlots}`);
    console.log(`📊 Slots with totalBookedPlants > 0: ${slotsWithBookings}`);
    console.log(`📊 Slots with orders array: ${slotsWithOrders}\n`);

    // Step 4: Reset all slot booking data
    if (slotsWithBookings > 0 || slotsWithOrders > 0) {
      console.log('🔄 Resetting slot booking data...\n');
      let resetCount = 0;

      for (const plantSlot of plantSlots) {
        let plantSlotModified = false;

        for (const subtypeSlot of plantSlot.subtypeSlots || []) {
          for (const slot of subtypeSlot.slots || []) {
            if (slot.totalBookedPlants > 0 || (slot.orders && slot.orders.length > 0)) {
              slot.totalBookedPlants = 0;
              slot.orders = [];
              slot.overflow = false;
              slot.isOverflow = false;
              slot.status = false;
              slot.primarySowed = 0;
              slot.officeSowed = 0;
              slot.plantsSowed = 0;
              plantSlotModified = true;
              resetCount++;
            }
          }
        }

        if (plantSlotModified) {
          await plantSlot.save();
        }
      }

      console.log(`✅ Reset ${resetCount} slots with booking data\n`);
    }

    // Step 5: Verify no reminders should be returned
    console.log('🧪 Testing reminders query...\n');

    // Simulate the reminders query
    const slotWiseReminders = await PlantSlot.aggregate([
      {
        $unwind: "$subtypeSlots"
      },
      {
        $unwind: "$subtypeSlots.slots"
      },
      {
        $lookup: {
          from: "orders",
          let: { slotId: "$subtypeSlots.slots._id" },
          pipeline: [
            {
              $match: {
                orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
                $expr: {
                  $eq: ["$bookingSlot", "$$slotId"]
                }
              }
            },
            {
              $group: {
                _id: null,
                totalBooked: { $sum: "$numberOfPlants" }
              }
            }
          ],
          as: "slotOrders"
        }
      },
      {
        $addFields: {
          ordersBooked: {
            $ifNull: [
              { $arrayElemAt: ["$slotOrders.totalBooked", 0] },
              0
            ]
          }
        }
      },
      {
        $match: {
          ordersBooked: { $gt: 0 }
        }
      }
    ]);

    const orderWiseReminders = await Order.aggregate([
      {
        $match: {
          deliveryDate: { $exists: true, $ne: null },
          status: { $in: ["PENDING", "PROCESSING"] }
        }
      }
    ]);

    console.log(`📊 Slot-wise reminders found: ${slotWiseReminders.length}`);
    console.log(`📊 Order-wise reminders found: ${orderWiseReminders.length}\n`);

    if (slotWiseReminders.length > 0 || orderWiseReminders.length > 0) {
      console.log('⚠️  WARNING: Reminders are still being returned!');
      console.log('   This suggests there are still orders or slot booking data.\n');
      
      if (slotWiseReminders.length > 0) {
        console.log('   Slot-wise reminders details:');
        slotWiseReminders.slice(0, 5).forEach((reminder, index) => {
          console.log(`   ${index + 1}. Slot ID: ${reminder._id}, Orders Booked: ${reminder.ordersBooked}`);
        });
        if (slotWiseReminders.length > 5) {
          console.log(`   ...and ${slotWiseReminders.length - 5} more`);
        }
      }

      if (orderWiseReminders.length > 0) {
        console.log('   Order-wise reminders details:');
        console.log(`   Found ${orderWiseReminders.length} orders with status PENDING or PROCESSING`);
      }
    } else {
      console.log('✅ No reminders found - database is clean!\n');
    }

    // Step 6: Final summary
    console.log('='.repeat(60));
    console.log('📊 FINAL SUMMARY');
    console.log('='.repeat(60));
    console.log(`Orders:              ${orderCount}`);
    console.log(`Plant Slots:         ${slotCount}`);
    console.log(`Total Slots:         ${totalSlots}`);
    console.log(`Slots Reset:         ${slotsWithBookings + slotsWithOrders}`);
    console.log(`Slot Reminders:      ${slotWiseReminders.length}`);
    console.log(`Order Reminders:     ${orderWiseReminders.length}`);
    console.log('='.repeat(60));

    if (slotWiseReminders.length === 0 && orderWiseReminders.length === 0) {
      console.log('\n✅ Database is clean - no reminders should be returned!\n');
    } else {
      console.log('\n⚠️  Action required: Please check the data above\n');
    }

  } catch (error) {
    console.error('\n❌ Error:', error);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed\n');
    process.exit(0);
  }
};

fixRemindersAfterClear();





