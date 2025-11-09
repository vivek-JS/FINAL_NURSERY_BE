import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Order from './models/order.model.js';
import DealerOrder from './models/dealerOrder.model.js';
import PlantSlot from './models/slots.model.js';
import User from './models/user.model.js';
import Employee from './models/employee.model.js';
import Farmer from './models/farmer.model.js';
import Dispatch from './models/dispatch.model.js';
import DealerBooking from './models/dealerBooking.model.js';
import DealerWallet from './models/dealerWallet.js';
import Sowing from './models/sowing.model.js';
import Attendance from './models/attendance.model.js';
import Lab from './models/lab.model.js';
import Log from './models/log.model.js';
import PlantOutward from './models/plantOutward.model.js';
import InventoryTransaction from './models/inventoryTransaction.model.js';
import InventoryOutward from './models/inventoryOutward.model.js';

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

// Function to clear all data
const clearAllData = async () => {
  try {
    console.log('\n🗑️  STARTING COMPLETE DATA DELETION...');
    console.log('⚠️  WARNING: This will delete ALL data from the system!\n');

    await connectDB();

    const results = {
      dispatches: 0,
      orders: 0,
      dealerOrders: 0,
      dealerBookings: 0,
      dealerWallets: 0,
      slots: 0,
      plantOutward: 0,
      sowings: 0,
      attendance: 0,
      labs: 0,
      logs: 0,
      inventoryTransactions: 0,
      inventoryOutward: 0,
      dealers: 0,
      farmers: 0,
      employees: 0,
      users: 0,
    };

    // Step 1: Delete dispatches
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

    // Step 7: Delete plant outward records
    console.log('\n7️⃣ Deleting Plant Outward Records...');
    const plantOutwardResult = await PlantOutward.deleteMany({});
    results.plantOutward = plantOutwardResult.deletedCount;
    console.log(`   ✅ Deleted ${plantOutwardResult.deletedCount} plant outward records`);

    // Step 8: Delete sowing records
    console.log('\n8️⃣ Deleting Sowing Records...');
    const sowingResult = await Sowing.deleteMany({});
    results.sowings = sowingResult.deletedCount;
    console.log(`   ✅ Deleted ${sowingResult.deletedCount} sowing records`);

    // Step 9: Delete attendance records
    console.log('\n9️⃣ Deleting Attendance Records...');
    const attendanceResult = await Attendance.deleteMany({});
    results.attendance = attendanceResult.deletedCount;
    console.log(`   ✅ Deleted ${attendanceResult.deletedCount} attendance records`);

    // Step 10: Delete lab records
    console.log('\n🔟 Deleting Lab Records...');
    const labResult = await Lab.deleteMany({});
    results.labs = labResult.deletedCount;
    console.log(`   ✅ Deleted ${labResult.deletedCount} lab records`);

    // Step 11: Delete log records
    console.log('\n1️⃣1️⃣ Deleting Log Records...');
    const logResult = await Log.deleteMany({});
    results.logs = logResult.deletedCount;
    console.log(`   ✅ Deleted ${logResult.deletedCount} log records`);

    // Step 12: Delete inventory transactions
    console.log('\n1️⃣2️⃣ Deleting Inventory Transactions...');
    const inventoryTransactionResult = await InventoryTransaction.deleteMany({});
    results.inventoryTransactions = inventoryTransactionResult.deletedCount;
    console.log(`   ✅ Deleted ${inventoryTransactionResult.deletedCount} inventory transactions`);

    // Step 13: Delete inventory outward records
    console.log('\n1️⃣3️⃣ Deleting Inventory Outward Records...');
    const inventoryOutwardResult = await InventoryOutward.deleteMany({});
    results.inventoryOutward = inventoryOutwardResult.deletedCount;
    console.log(`   ✅ Deleted ${inventoryOutwardResult.deletedCount} inventory outward records`);

    // Step 14: Delete dealers
    console.log('\n1️⃣4️⃣ Deleting Dealers...');
    const dealerResult = await User.deleteMany({ role: 'DEALER' });
    results.dealers = dealerResult.deletedCount;
    console.log(`   ✅ Deleted ${dealerResult.deletedCount} dealers`);

    // Step 15: Delete farmers
    console.log('\n1️⃣5️⃣ Deleting Farmers...');
    const farmerResult = await Farmer.deleteMany({});
    results.farmers = farmerResult.deletedCount;
    console.log(`   ✅ Deleted ${farmerResult.deletedCount} farmers`);

    // Step 16: Delete employees
    console.log('\n1️⃣6️⃣ Deleting Employees...');
    const employeeResult = await Employee.deleteMany({});
    results.employees = employeeResult.deletedCount;
    console.log(`   ✅ Deleted ${employeeResult.deletedCount} employees`);

    // Step 17: Delete all non-admin users
    console.log('\n1️⃣7️⃣ Deleting Non-Admin Users...');
    const userResult = await User.deleteMany({ role: { $ne: 'SUPER_ADMIN' } });
    results.users = userResult.deletedCount;
    console.log(`   ✅ Deleted ${userResult.deletedCount} non-admin users`);

    // Show final summary
    console.log('\n📊 DELETION SUMMARY:');
    console.log('='.repeat(50));
    console.log(`Dispatches:      ${results.dispatches}`);
    console.log(`Orders:          ${results.orders}`);
    console.log(`Dealer Orders:   ${results.dealerOrders}`);
    console.log(`Dealer Bookings: ${results.dealerBookings}`);
    console.log(`Dealer Wallets:  ${results.dealerWallets}`);
    console.log(`Slots:           ${results.slots}`);
    console.log(`Plant Outward:   ${results.plantOutward}`);
    console.log(`Sowings:         ${results.sowings}`);
    console.log(`Attendance:      ${results.attendance}`);
    console.log(`Labs:            ${results.labs}`);
    console.log(`Logs:            ${results.logs}`);
    console.log(`Inventory Txns:  ${results.inventoryTransactions}`);
    console.log(`Inventory Out:   ${results.inventoryOutward}`);
    console.log(`Dealers:         ${results.dealers}`);
    console.log(`Farmers:         ${results.farmers}`);
    console.log(`Employees:       ${results.employees}`);
    console.log(`Non-Admin Users: ${results.users}`);
    console.log('='.repeat(50));

    // Check if any SUPER_ADMIN users remain
    const remainingUsers = await User.find({ role: 'SUPER_ADMIN' });
    if (remainingUsers.length > 0) {
      console.log(`\n👤 Preserved ${remainingUsers.length} SUPER_ADMIN user(s):`);
      remainingUsers.forEach(user => {
        console.log(`   - ${user.name} (${user.phoneNumber})`);
      });
    }

    console.log('\n✅ All data deleted successfully!');
    console.log('🎉 Database cleanup completed!');

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
clearAllData();





