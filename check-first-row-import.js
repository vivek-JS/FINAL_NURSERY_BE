import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Order from './models/order.model.js';
import Farmer from './models/farmer.model.js';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error("MONGO_URL or MONGODB_URI environment variable is required.");
    }
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
};

const checkFirstRowImport = async () => {
  try {
    await connectDB();

    // First row data from Excel
    const firstRowData = {
      name: "Arun Pundalik Patil",
      mobileNumber: 9284775531,
      address: "Kasali",
      taluka: "Jamner",
      district: "Jalgaon",
      bookingNo: 0,
      expectedDelDate: "2025-11-10",
      plantQty: 5000,
      rate: 17,
      crop: "Banana",
      variety: "G-9",
      media: "8 Cavity",
      delYN: "N",
      advanceAmt: 12500,
      orderBy: "Sandip p",
      refrence: "Sandip p"
    };

    console.log('🔍 Checking if first row has been imported...');
    console.log('═══════════════════════════════════════════════\n');
    console.log('📋 First Row Data from Excel:');
    console.log('─────────────────────────────────────────────');
    console.log(`Name: ${firstRowData.name}`);
    console.log(`Mobile: ${firstRowData.mobileNumber}`);
    console.log(`Address: ${firstRowData.address}`);
    console.log(`Taluka: ${firstRowData.taluka}`);
    console.log(`District: ${firstRowData.district}`);
    console.log(`Booking NO.: ${firstRowData.bookingNo}`);
    console.log(`Expected Del. Date: ${firstRowData.expectedDelDate}`);
    console.log(`Plant Qty.: ${firstRowData.plantQty}`);
    console.log(`Rate: ${firstRowData.rate}`);
    console.log(`Crop: ${firstRowData.crop}`);
    console.log(`Variety: ${firstRowData.variety}`);
    console.log(`Media: ${firstRowData.media}`);
    console.log(`Del. Y/N: ${firstRowData.delYN}`);
    console.log(`Advance Amt.: ${firstRowData.advanceAmt}`);
    console.log(`Order By: ${firstRowData.orderBy}`);
    console.log(`Reference: ${firstRowData.refrence}\n`);

    // Check for farmer
    console.log('🔍 Step 1: Checking for Farmer...');
    let farmer = await Farmer.findOne({
      mobileNumber: firstRowData.mobileNumber
    }).lean();

    if (!farmer) {
      farmer = await Farmer.findOne({
        name: firstRowData.name,
        village: firstRowData.address,
        taluka: firstRowData.taluka,
        district: firstRowData.district
      }).lean();
    }

    if (farmer) {
      console.log('✅ Farmer Found:');
      console.log(`   ID: ${farmer._id}`);
      console.log(`   Name: ${farmer.name}`);
      console.log(`   Mobile: ${farmer.mobileNumber || 'N/A'}`);
      console.log(`   Address: ${farmer.village}, ${farmer.taluka}, ${farmer.district}\n`);
    } else {
      console.log('❌ Farmer NOT found in database\n');
    }

    // Check for order
    console.log('🔍 Step 2: Checking for Order...');
    let order = null;

    if (farmer) {
      // First try: Find order by farmer and exact details
      let orders = await Order.find({
        farmer: farmer._id,
        numberOfPlants: firstRowData.plantQty,
        rate: firstRowData.rate
      })
      .populate('farmer', 'name mobileNumber village')
      .populate('plantName', 'name')
      .populate('cavity', 'cavity name')
      .populate('salesPerson', 'name')
      .lean();

      // If not found, try broader search
      if (orders.length === 0) {
        console.log('   Trying broader search (by farmer only)...');
        orders = await Order.find({
          farmer: farmer._id
        })
        .populate('farmer', 'name mobileNumber village')
        .populate('plantName', 'name')
        .populate('cavity', 'cavity name')
        .populate('salesPerson', 'name')
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();
      }

      if (orders.length > 0) {
        console.log(`✅ Found ${orders.length} matching order(s):\n`);
        
        orders.forEach((ord, idx) => {
          console.log(`   Order ${idx + 1}:`);
          console.log(`   ───────────────────────────────────────────`);
          console.log(`   Order ID: ${ord.orderId}`);
          console.log(`   Farmer: ${ord.farmer?.name || 'N/A'} (${ord.farmer?.mobileNumber || 'N/A'})`);
          console.log(`   Plant: ${ord.plantName?.name || 'N/A'}`);
          console.log(`   Number of Plants: ${ord.numberOfPlants}`);
          console.log(`   Rate: ${ord.rate}`);
          console.log(`   Order Status: ${ord.orderStatus}`);
          console.log(`   Payment Status: ${ord.orderPaymentStatus}`);
          console.log(`   Cavity: ${ord.cavity ? `${ord.cavity.cavity} Cavity (${ord.cavity.name})` : 'Not Set'}`);
          console.log(`   Sales Person: ${ord.salesPerson?.name || 'N/A'}`);
          console.log(`   Delivery Date: ${ord.deliveryDate ? new Date(ord.deliveryDate).toLocaleDateString() : 'N/A'}`);
          console.log(`   Booking Date: ${ord.orderBookingDate ? new Date(ord.orderBookingDate).toLocaleDateString() : 'N/A'}`);
          
          if (ord.payment && ord.payment.length > 0) {
            console.log(`   Payments:`);
            ord.payment.forEach((pay, pIdx) => {
              console.log(`      Payment ${pIdx + 1}: ${pay.paidAmount} - ${pay.paymentStatus} - ${pay.modeOfPayment || 'N/A'}`);
            });
          }
          console.log();
          
          if (idx === 0) {
            order = ord;
          }
        });
      } else {
        console.log('❌ No matching orders found\n');
        
        // Check all orders for this farmer
        console.log('🔍 Checking all orders for this farmer...');
        const allFarmerOrders = await Order.find({
          farmer: farmer._id
        })
        .populate('plantName', 'name')
        .populate('cavity', 'cavity name')
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();
        
        if (allFarmerOrders.length > 0) {
          console.log(`   Found ${allFarmerOrders.length} other order(s) for this farmer:\n`);
          allFarmerOrders.forEach((ord, idx) => {
            console.log(`   Order ${idx + 1}:`);
            console.log(`   ───────────────────────────────────────────`);
            console.log(`   Order ID: ${ord.orderId}`);
            console.log(`   Plant: ${ord.plantName?.name || 'N/A'}`);
            console.log(`   Number of Plants: ${ord.numberOfPlants}`);
            console.log(`   Rate: ${ord.rate}`);
            console.log(`   Status: ${ord.orderStatus}`);
            console.log(`   Cavity: ${ord.cavity ? `${ord.cavity.cavity} Cavity` : 'Not Set'}`);
            console.log();
          });
        }
      }
    }

    // Summary
    console.log('═══════════════════════════════════════════════');
    console.log('📊 SUMMARY:');
    console.log('─────────────────────────────────────────────');
    console.log(`Farmer Imported: ${farmer ? '✅ YES' : '❌ NO'}`);
    console.log(`Order Imported: ${order ? '✅ YES' : '❌ NO'}`);
    
    if (order) {
      console.log(`\n📝 Import Status Details:`);
      console.log(`   Order Status: ${order.orderStatus}`);
      console.log(`   Expected Status (from Del. Y/N = "${firstRowData.delYN}"):`);
      
      // Status mapping based on user's requirement
      let expectedStatus;
      if (firstRowData.delYN === 'Y' || firstRowData.delYN === 'y') {
        expectedStatus = 'COMPLETED';
      } else if (firstRowData.delYN === 'TC' || firstRowData.delYN === 'tc') {
        expectedStatus = 'PENDING';
      } else if (firstRowData.delYN === 'N' || firstRowData.delYN === 'n') {
        expectedStatus = 'ACCEPTED';
      } else {
        expectedStatus = 'ACCEPTED (default)';
      }
      
      console.log(`   Expected: ${expectedStatus}`);
      console.log(`   Current: ${order.orderStatus}`);
      console.log(`   Match: ${order.orderStatus === expectedStatus ? '✅' : '⚠️  MISMATCH'}`);
      
      console.log(`\n   Cavity Status:`);
      console.log(`   Media in Excel: ${firstRowData.media}`);
      console.log(`   Cavity in Order: ${order.cavity ? `${order.cavity.cavity} Cavity (${order.cavity.name})` : '❌ NOT SET'}`);
      console.log(`   Match: ${order.cavity ? '✅' : '❌ NOT MATCHED'}`);
    }

    console.log('\n');

  } catch (error) {
    console.error('❌ Error checking import:', error);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed');
  }
};

checkFirstRowImport();

