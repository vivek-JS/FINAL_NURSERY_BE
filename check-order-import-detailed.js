import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Order from './models/order.model.js';
import Farmer from './models/farmer.model.js';
import PlantCms from './models/plantCms.model.js';
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

const checkOrderImport = async () => {
  try {
    await connectDB();

    // First row data
    const searchData = {
      name: "Arun Pundalik Patil",
      mobileNumber: 9284775531,
      address: "Kasali",
      plantQty: 5000,
      rate: 17,
      crop: "Banana",
      variety: "G-9"
    };

    console.log('🔍 Detailed Order Import Check');
    console.log('═══════════════════════════════════════════════\n');

    // Step 1: Find farmer
    console.log('📋 Step 1: Finding Farmer...');
    let farmer = await Farmer.findOne({
      mobileNumber: searchData.mobileNumber
    }).lean();

    if (!farmer) {
      farmer = await Farmer.findOne({
        name: searchData.name
      }).lean();
    }

    if (!farmer) {
      console.log('❌ Farmer NOT found!\n');
      await mongoose.connection.close();
      return;
    }

    console.log(`✅ Farmer Found: ${farmer.name} (${farmer._id})\n`);

    // Step 2: Find plant
    console.log('📋 Step 2: Finding Plant...');
    const plant = await PlantCms.findOne({
      name: { $regex: new RegExp(searchData.crop, 'i') }
    }).lean();

    if (!plant) {
      console.log(`❌ Plant "${searchData.crop}" NOT found!\n`);
    } else {
      console.log(`✅ Plant Found: ${plant.name} (${plant._id})\n`);
    }

    // Step 3: Check all orders for this farmer
    console.log('📋 Step 3: Checking ALL Orders for this Farmer...');
    const allOrders = await Order.find({
      farmer: farmer._id
    })
    .populate('plantName', 'name')
    .populate('cavity', 'cavity name')
    .populate('salesPerson', 'name')
    .sort({ createdAt: -1 })
    .lean();

    console.log(`Found ${allOrders.length} total order(s) for this farmer\n`);

    if (allOrders.length === 0) {
      console.log('❌ NO ORDERS FOUND for this farmer!');
      console.log('\n📊 This means:');
      console.log('   - Farmer exists ✅');
      console.log('   - But order has NOT been imported yet ❌');
      console.log('\n💡 You need to import the order using the Excel import function.');
    } else {
      console.log('✅ Orders found for this farmer:\n');
      allOrders.forEach((ord, idx) => {
        console.log(`Order ${idx + 1}:`);
        console.log('──────────────────────────────────────────');
        console.log(`Order ID: ${ord.orderId}`);
        console.log(`Plant: ${ord.plantName?.name || 'N/A'}`);
        console.log(`Number of Plants: ${ord.numberOfPlants}`);
        console.log(`Rate: ${ord.rate}`);
        console.log(`Total Amount: ${ord.numberOfPlants * ord.rate}`);
        console.log(`Order Status: ${ord.orderStatus}`);
        console.log(`Payment Status: ${ord.orderPaymentStatus}`);
        console.log(`Cavity: ${ord.cavity ? `${ord.cavity.cavity} Cavity (${ord.cavity.name})` : 'Not Set'}`);
        console.log(`Sales Person: ${ord.salesPerson?.name || 'N/A'}`);
        console.log(`Delivery Date: ${ord.deliveryDate ? new Date(ord.deliveryDate).toLocaleDateString() : 'N/A'}`);
        console.log(`Booking Date: ${ord.orderBookingDate ? new Date(ord.orderBookingDate).toLocaleDateString() : 'N/A'}`);
        console.log(`Created At: ${ord.createdAt ? new Date(ord.createdAt).toLocaleString() : 'N/A'}`);
        
        // Check if this matches our search criteria
        const matchesQty = ord.numberOfPlants === searchData.plantQty;
        const matchesRate = ord.rate === searchData.rate;
        const matchesPlant = ord.plantName?.name?.toLowerCase().includes(searchData.crop.toLowerCase());
        
        if (matchesQty && matchesRate && matchesPlant) {
          console.log(`\n🎯 MATCH! This order matches the first row data!`);
        } else {
          console.log(`\n⚠️  This order does NOT match first row data:`);
          console.log(`   Qty match: ${matchesQty ? '✅' : '❌'} (${ord.numberOfPlants} vs ${searchData.plantQty})`);
          console.log(`   Rate match: ${matchesRate ? '✅' : '❌'} (${ord.rate} vs ${searchData.rate})`);
          console.log(`   Plant match: ${matchesPlant ? '✅' : '❌'}`);
        }
        
        if (ord.payment && ord.payment.length > 0) {
          console.log(`\n   Payments:`);
          ord.payment.forEach((pay, pIdx) => {
            console.log(`      ${pIdx + 1}. ${pay.paidAmount} - ${pay.paymentStatus} - ${pay.modeOfPayment || 'N/A'}`);
          });
        }
        console.log();
      });
    }

    // Step 4: Search by exact criteria
    console.log('\n📋 Step 4: Searching by Exact Criteria...');
    const exactMatches = await Order.find({
      farmer: farmer._id,
      numberOfPlants: searchData.plantQty,
      rate: searchData.rate
    })
    .populate('plantName', 'name')
    .lean();

    if (exactMatches.length > 0) {
      console.log(`✅ Found ${exactMatches.length} exact match(es)!`);
      exactMatches.forEach((ord, idx) => {
        console.log(`   Match ${idx + 1}: Order ID ${ord.orderId}, Plant: ${ord.plantName?.name || 'N/A'}`);
      });
    } else {
      console.log('❌ No exact matches found');
      console.log('   Searching for:');
      console.log(`   - Qty: ${searchData.plantQty}`);
      console.log(`   - Rate: ${searchData.rate}`);
      console.log(`   - Crop: ${searchData.crop}`);
    }

    console.log('\n═══════════════════════════════════════════════');
    console.log('📊 FINAL SUMMARY:');
    console.log('─────────────────────────────────────────────');
    console.log(`Farmer Imported: ✅ YES`);
    console.log(`Total Orders for Farmer: ${allOrders.length}`);
    console.log(`First Row Order Imported: ${exactMatches.length > 0 ? '✅ YES' : '❌ NO'}`);
    
    if (exactMatches.length === 0 && allOrders.length > 0) {
      console.log('\n⚠️  NOTE: Farmer has orders, but not the specific first row order.');
      console.log('   The order with exact matching criteria (Qty: 5000, Rate: 17) is NOT found.');
    } else if (exactMatches.length === 0) {
      console.log('\n❌ ORDER NOT IMPORTED');
      console.log('   The first row order has not been imported yet.');
      console.log('   You need to run the Excel import to import this order.');
    }

    console.log('\n');

  } catch (error) {
    console.error('❌ Error checking import:', error);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed');
  }
};

checkOrderImport();



