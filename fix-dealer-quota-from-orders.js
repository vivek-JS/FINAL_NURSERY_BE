import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Order from './models/order.model.js';
import DealerWallet from './models/dealerWallet.js';
import PlantCms from './models/plantCms.model.js';

dotenv.config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

const fixDealerQuotaFromOrders = async () => {
  try {
    console.log('🔄 Starting dealer quota recalculation from orders...');
    
    // Get the specific dealer ID
    const dealerId = '687d117376f804e3493ded6c';
    
    // Get all orders for this dealer
    const orders = await Order.find({ 
      salesPerson: dealerId,
      dealerOrder: true 
    });
    
    console.log(`📋 Found ${orders.length} orders for dealer ${dealerId}`);
    
    // Calculate total quota from ACCEPTED orders
    let totalQuota = 0;
    const acceptedOrders = [];
    
    orders.forEach(order => {
      console.log(`Order ${order.orderId}: Status = ${order.orderStatus}, Plants = ${order.numberOfPlants}`);
      
      if (order.orderStatus === 'ACCEPTED') {
        totalQuota += order.numberOfPlants;
        acceptedOrders.push({
          orderId: order.orderId,
          numberOfPlants: order.numberOfPlants,
          plantType: order.plantName,
          plantSubtype: order.plantSubtype,
          bookingSlot: order.bookingSlot
        });
      }
    });
    
    console.log(`✅ Total quota from ACCEPTED orders: ${totalQuota}`);
    console.log(`📝 Accepted orders:`, acceptedOrders);
    
    // Find or create dealer wallet
    let dealerWallet = await DealerWallet.findOne({ dealer: dealerId });
    
    if (!dealerWallet) {
      console.log('💰 Creating new dealer wallet...');
      dealerWallet = new DealerWallet({
        dealer: dealerId,
        availableAmount: 0,
        entries: [],
        transactions: []
      });
    }
    
    // Clear existing entries
    dealerWallet.entries = [];
    
    // Add entries for each accepted order
    acceptedOrders.forEach(order => {
      dealerWallet.entries.push({
        plantType: order.plantType,
        subType: order.plantSubtype,
        bookingSlot: order.bookingSlot,
        quantity: order.numberOfPlants,
        bookedQuantity: 0, // No orders use dealer quota directly
        remainingQuantity: order.numberOfPlants
      });
    });
    
    // Save the wallet
    await dealerWallet.save();
    
    console.log('✅ Dealer wallet updated successfully');
    console.log(`💰 Total quota: ${totalQuota}`);
    console.log(`📊 Entries count: ${dealerWallet.entries.length}`);
    
    // Verify the update
    const updatedWallet = await DealerWallet.findOne({ dealer: dealerId });
    const totalQuantity = updatedWallet.entries.reduce((sum, entry) => sum + (entry.quantity || 0), 0);
    const totalBooked = updatedWallet.entries.reduce((sum, entry) => sum + (entry.bookedQuantity || 0), 0);
    const totalRemaining = updatedWallet.entries.reduce((sum, entry) => sum + (entry.remainingQuantity || 0), 0);
    
    console.log('\n📊 Final Dealer Quota Summary:');
    console.log(`Total Quota: ${totalQuantity.toLocaleString()}`);
    console.log(`Booked from Dealer Quota: ${totalBooked.toLocaleString()}`);
    console.log(`Remaining Dealer Quota: ${totalRemaining.toLocaleString()}`);
    
    console.log('\n✅ Dealer quota recalculation completed successfully!');
    
  } catch (error) {
    console.error('❌ Error fixing dealer quota:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
};

// Run the script
connectDB().then(() => {
  fixDealerQuotaFromOrders();
}); 