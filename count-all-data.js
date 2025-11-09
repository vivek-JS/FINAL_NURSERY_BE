import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Import all models
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

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ MongoDB Connected\n');
  } catch (error) {
    console.error('❌ Error connecting to MongoDB:', error);
    process.exit(1);
  }
};

// Function to count all data
const countAllData = async () => {
  try {
    await connectDB();

    console.log('📊 COUNTING ALL DATA IN DATABASE...');
    console.log('='.repeat(60));

    const counts = {};

    // Count Orders
    counts.orders = await Order.countDocuments();
    console.log(`📦 Orders:                ${counts.orders}`);

    // Count Dealer Orders
    counts.dealerOrders = await DealerOrder.countDocuments();
    console.log(`🛒 Dealer Orders:         ${counts.dealerOrders}`);

    // Count Dispatches
    counts.dispatches = await Dispatch.countDocuments();
    console.log(`🚚 Dispatches:            ${counts.dispatches}`);

    // Count Dealer Bookings
    counts.dealerBookings = await DealerBooking.countDocuments();
    console.log(`📅 Dealer Bookings:       ${counts.dealerBookings}`);

    // Count Dealer Wallets
    counts.dealerWallets = await DealerWallet.countDocuments();
    console.log(`💰 Dealer Wallets:        ${counts.dealerWallets}`);

    // Count Slots
    counts.slots = await PlantSlot.countDocuments();
    console.log(`🌱 Slots:                 ${counts.slots}`);

    // Count Plant Outward
    counts.plantOutward = await PlantOutward.countDocuments();
    console.log(`🌿 Plant Outward:         ${counts.plantOutward}`);

    // Count Sowings
    counts.sowings = await Sowing.countDocuments();
    console.log(`🌾 Sowings:               ${counts.sowings}`);

    // Count Attendance
    counts.attendance = await Attendance.countDocuments();
    console.log(`📋 Attendance:            ${counts.attendance}`);

    // Count Lab records
    counts.labs = await Lab.countDocuments();
    console.log(`🔬 Labs:                  ${counts.labs}`);

    // Count Logs
    counts.logs = await Log.countDocuments();
    console.log(`📝 Logs:                  ${counts.logs}`);

    // Count Inventory Transactions
    counts.inventoryTransactions = await InventoryTransaction.countDocuments();
    console.log(`📊 Inventory Transactions: ${counts.inventoryTransactions}`);

    // Count Inventory Outward
    counts.inventoryOutward = await InventoryOutward.countDocuments();
    console.log(`📤 Inventory Outward:     ${counts.inventoryOutward}`);

    // Count Dealers
    counts.dealers = await User.countDocuments({ role: 'DEALER' });
    console.log(`👤 Dealers:               ${counts.dealers}`);

    // Count Farmers
    counts.farmers = await Farmer.countDocuments();
    console.log(`🌾 Farmers:                ${counts.farmers}`);

    // Count Employees
    counts.employees = await Employee.countDocuments();
    console.log(`👔 Employees:              ${counts.employees}`);

    // Count all Users
    const allUsers = await User.countDocuments();
    const adminUsers = await User.countDocuments({ role: 'SUPER_ADMIN' });
    const nonAdminUsers = allUsers - adminUsers;
    
    counts.allUsers = allUsers;
    counts.adminUsers = adminUsers;
    counts.nonAdminUsers = nonAdminUsers;
    
    console.log(`👥 All Users:             ${counts.allUsers}`);
    console.log(`👑 Super Admins:          ${counts.adminUsers}`);
    console.log(`👤 Non-Admin Users:       ${counts.nonAdminUsers}`);

    console.log('='.repeat(60));
    
    // Calculate total records to be deleted
    const totalRecords = 
      counts.orders +
      counts.dealerOrders +
      counts.dispatches +
      counts.dealerBookings +
      counts.dealerWallets +
      counts.slots +
      counts.plantOutward +
      counts.sowings +
      counts.attendance +
      counts.labs +
      counts.logs +
      counts.inventoryTransactions +
      counts.inventoryOutward +
      counts.dealers +
      counts.farmers +
      counts.employees +
      counts.nonAdminUsers;

    console.log(`\n📈 TOTAL RECORDS TO DELETE: ${totalRecords}`);
    console.log(`✅ RECORDS TO PRESERVE:     ${counts.adminUsers} (Super Admin users)`);
    console.log('='.repeat(60));

    // Show breakdown by category
    console.log('\n📊 Breakdown by Category:');
    console.log('─'.repeat(60));
    console.log('ORDER DATA:');
    console.log(`  • Orders: ${counts.orders}`);
    console.log(`  • Dealer Orders: ${counts.dealerOrders}`);
    console.log(`  • Dispatches: ${counts.dispatches}`);
    console.log(`  • Dealer Bookings: ${counts.dealerBookings}`);
    console.log(`  • Dealer Wallets: ${counts.dealerWallets}`);
    
    console.log('\nSLOT DATA:');
    console.log(`  • Slots: ${counts.slots}`);
    
    console.log('\nPRODUCTION DATA:');
    console.log(`  • Plant Outward: ${counts.plantOutward}`);
    console.log(`  • Sowings: ${counts.sowings}`);
    
    console.log('\nOPERATIONAL DATA:');
    console.log(`  • Attendance: ${counts.attendance}`);
    console.log(`  • Labs: ${counts.labs}`);
    console.log(`  • Logs: ${counts.logs}`);
    
    console.log('\nINVENTORY DATA:');
    console.log(`  • Inventory Transactions: ${counts.inventoryTransactions}`);
    console.log(`  • Inventory Outward: ${counts.inventoryOutward}`);
    
    console.log('\nUSER DATA:');
    console.log(`  • Dealers: ${counts.dealers}`);
    console.log(`  • Farmers: ${counts.farmers}`);
    console.log(`  • Employees: ${counts.employees}`);
    console.log(`  • Non-Admin Users: ${counts.nonAdminUsers}`);
    console.log(`  • Super Admins (PRESERVED): ${counts.adminUsers}`);
    
    console.log('─'.repeat(60));
    console.log(`\n⚠️  WARNING: Running delete will remove ${totalRecords} records!`);
    console.log(`✅ Only ${counts.adminUsers} Super Admin user(s) will be preserved.\n`);

  } catch (error) {
    console.error('❌ Error counting data:', error);
    throw error;
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  }
};

// Run the script
countAllData();





