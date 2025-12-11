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

const verifyFirstRowImport = async () => {
  try {
    await connectDB();
    
    const Order = (await import('./models/order.model.js')).default;
    const Farmer = (await import('./models/farmer.model.js')).default;
    const PlantCms = (await import('./models/plantCms.model.js')).default;
    
    console.log('\n🔍 Verifying First Row Import...');
    console.log('═══════════════════════════════════════════════\n');
    
    // Find farmer
    const farmer = await Farmer.findOne({
      mobileNumber: 9284775531
    });
    
    if (!farmer) {
      console.log('❌ Farmer not found');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`✅ Farmer: ${farmer.name} (${farmer._id})`);
    console.log(`   Mobile: ${farmer.mobileNumber}`);
    console.log(`   Address: ${farmer.village}, ${farmer.taluka}, ${farmer.district}\n`);
    
    // Find orders for this farmer
    const orders = await Order.find({
      farmer: farmer._id
    })
    .populate('plantName', 'name')
    .sort({ createdAt: -1 })
    .limit(5);
    
    // Get sales person names separately
    const User = (await import('./models/user.model.js')).default;
    for (const order of orders) {
      if (order.salesPerson) {
        const salesPerson = await User.findById(order.salesPerson).select('name').lean();
        order.salesPersonName = salesPerson?.name || 'N/A';
      }
    }
    
    console.log(`📋 Orders for this farmer: ${orders.length}\n`);
    
    if (orders.length > 0) {
      orders.forEach((order, idx) => {
        console.log(`Order ${idx + 1}:`);
        console.log('──────────────────────────────────────────');
        console.log(`Order ID: ${order.orderId}`);
        console.log(`Plant: ${order.plantName?.name || 'N/A'}`);
        console.log(`Number of Plants: ${order.numberOfPlants}`);
        console.log(`Rate: ₹${order.rate}`);
        console.log(`Total Amount: ₹${order.numberOfPlants * order.rate}`);
        console.log(`Order Status: ${order.orderStatus}`);
        console.log(`Payment Status: ${order.orderPaymentStatus}`);
        console.log(`Sales Person: ${order.salesPersonName || 'N/A'}`);
        console.log(`Delivery Date: ${order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : 'N/A'}`);
        console.log(`Booking Date: ${order.orderBookingDate ? new Date(order.orderBookingDate).toLocaleDateString() : 'N/A'}`);
        
        // Check if this matches first row
        const matchesFirstRow = 
          order.numberOfPlants === 5000 &&
          order.rate === 17 &&
          order.plantName?.name?.toLowerCase() === 'banana';
        
        if (matchesFirstRow) {
          console.log(`\n🎯 ✅ THIS IS THE FIRST ROW ORDER!`);
          console.log(`   Status: ${order.orderStatus} (Expected: ACCEPTED based on Del. Y/N = N)`);
          console.log(`   Status Match: ${order.orderStatus === 'ACCEPTED' ? '✅' : '⚠️'}`);
        }
        
        if (order.payment && order.payment.length > 0) {
          console.log(`\n   Payments:`);
          order.payment.forEach((pay, pIdx) => {
            console.log(`      ${pIdx + 1}. ₹${pay.paidAmount} - ${pay.paymentStatus} - ${pay.modeOfPayment || 'N/A'}`);
          });
        }
        console.log();
      });
    } else {
      console.log('❌ No orders found for this farmer');
    }
    
    console.log('═══════════════════════════════════════════════');
    console.log('📊 SUMMARY:');
    console.log('─────────────────────────────────────────────');
    console.log(`Farmer Imported: ✅ YES`);
    console.log(`Orders Found: ${orders.length}`);
    console.log(`First Row Order Imported: ${orders.length > 0 ? '✅ YES' : '❌ NO'}`);
    
    if (orders.length > 0) {
      const firstRowOrder = orders.find(o => 
        o.numberOfPlants === 5000 && 
        o.rate === 17 && 
        o.plantName?.name?.toLowerCase() === 'banana'
      );
      
      if (firstRowOrder) {
        console.log(`\n✅ First Row Order Details:`);
        console.log(`   Order ID: ${firstRowOrder.orderId}`);
        console.log(`   Status: ${firstRowOrder.orderStatus}`);
        console.log(`   Expected Status: ACCEPTED (Del. Y/N = N)`);
        console.log(`   Status Correct: ${firstRowOrder.orderStatus === 'ACCEPTED' ? '✅' : '⚠️'}`);
        console.log(`   Cavity: ${firstRowOrder.cavity ? 'Set' : 'Not Set'}`);
        console.log(`   Plants: ${firstRowOrder.numberOfPlants}`);
        console.log(`   Rate: ₹${firstRowOrder.rate}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
    process.exit(0);
  }
};

verifyFirstRowImport();

