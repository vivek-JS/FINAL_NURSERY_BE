import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Order from './models/order.model.js';
import DealerOrder from './models/dealerOrder.model.js';
import PlantSlot from './models/slots.model.js';
import Dispatch from './models/dispatch.model.js';
import DealerBooking from './models/dealerBooking.model.js';
import DealerWallet from './models/dealerWallet.js';
import Sowing from './models/sowing.model.js';
import SowingRequest from './models/sowingRequest.model.js';
import ReturnRequest from './models/returnRequest.model.js';

// Load environment variables
dotenv.config();

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ MongoDB Connected');
  } catch (error) {
    console.error('❌ Error connecting to MongoDB:', error);
    process.exit(1);
  }
};

// Function to clear orders, slots, and sowing data
const clearOrdersSlotsSowing = async () => {
  try {
    console.log('\n🗑️  STARTING DELETION: Orders, Slots & Sowing Data');
    console.log('⚠️  WARNING: This will delete all orders, slots, and sowing data!\n');

    await connectDB();

    const results = {
      dispatches: 0,
      orders: 0,
      dealerOrders: 0,
      dealerBookings: 0,
      dealerWallets: 0,
      slots: 0,
      sowings: 0,
      sowingRequests: 0,
      returnRequests: 0,
    };

    // Step 1: Delete dispatches (referenced by orders)
    console.log('1️⃣ Deleting Dispatches...');
    const dispatchResult = await Dispatch.deleteMany({});
    results.dispatches = dispatchResult.deletedCount;
    console.log(`   ✅ Deleted ${dispatchResult.deletedCount} dispatches`);

    // Step 2: Delete orders
    console.log('\n2️⃣ Deleting Orders...');
    const orderResult = await Order.deleteMany({});
    results.orders = orderResult.deletedCount;
    console.log(`   ✅ Deleted ${orderResult.deletedCount} orders`);

    // Step 3: Delete dealer orders
    console.log('\n3️⃣ Deleting Dealer Orders...');
    const dealerOrderResult = await DealerOrder.deleteMany({});
    results.dealerOrders = dealerOrderResult.deletedCount;
    console.log(`   ✅ Deleted ${dealerOrderResult.deletedCount} dealer orders`);

    // Step 4: Delete dealer bookings
    console.log('\n4️⃣ Deleting Dealer Bookings...');
    const dealerBookingResult = await DealerBooking.deleteMany({});
    results.dealerBookings = dealerBookingResult.deletedCount;
    console.log(`   ✅ Deleted ${dealerBookingResult.deletedCount} dealer bookings`);

    // Step 5: Delete dealer wallets
    console.log('\n5️⃣ Deleting Dealer Wallets...');
    const dealerWalletResult = await DealerWallet.deleteMany({});
    results.dealerWallets = dealerWalletResult.deletedCount;
    console.log(`   ✅ Deleted ${dealerWalletResult.deletedCount} dealer wallets`);

    // Step 6: Delete slots
    console.log('\n6️⃣ Deleting Slots...');
    const slotResult = await PlantSlot.deleteMany({});
    results.slots = slotResult.deletedCount;
    console.log(`   ✅ Deleted ${slotResult.deletedCount} slots`);

    // Step 7: Delete sowing records
    console.log('\n7️⃣ Deleting Sowing Records...');
    const sowingResult = await Sowing.deleteMany({});
    results.sowings = sowingResult.deletedCount;
    console.log(`   ✅ Deleted ${sowingResult.deletedCount} sowing records`);

    // Step 8: Delete sowing requests
    console.log('\n8️⃣ Deleting Sowing Requests...');
    const sowingRequestResult = await SowingRequest.deleteMany({});
    results.sowingRequests = sowingRequestResult.deletedCount;
    console.log(`   ✅ Deleted ${sowingRequestResult.deletedCount} sowing requests`);

    // Step 9: Delete return requests
    console.log('\n9️⃣ Deleting Return Requests...');
    const returnRequestResult = await ReturnRequest.deleteMany({});
    results.returnRequests = returnRequestResult.deletedCount;
    console.log(`   ✅ Deleted ${returnRequestResult.deletedCount} return requests`);

    // Show final summary
    console.log('\n📊 DELETION SUMMARY:');
    console.log('='.repeat(50));
    console.log(`Dispatches:      ${results.dispatches}`);
    console.log(`Orders:          ${results.orders}`);
    console.log(`Dealer Orders:   ${results.dealerOrders}`);
    console.log(`Dealer Bookings: ${results.dealerBookings}`);
    console.log(`Dealer Wallets:  ${results.dealerWallets}`);
    console.log(`Slots:           ${results.slots}`);
    console.log(`Sowings:         ${results.sowings}`);
    console.log(`Sowing Requests: ${results.sowingRequests}`);
    console.log(`Return Requests: ${results.returnRequests}`);
    console.log('='.repeat(50));

    const totalDeleted = Object.values(results).reduce((sum, count) => sum + count, 0);
    console.log(`\n✅ Total records deleted: ${totalDeleted}`);
    console.log('🎉 Orders, Slots & Sowing data cleared successfully!');

  } catch (error) {
    console.error('\n❌ Error during data deletion:', error);
    throw error;
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

// Run the script
clearOrdersSlotsSowing();
