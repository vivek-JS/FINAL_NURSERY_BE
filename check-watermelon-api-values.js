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

const checkWatermelonValues = async () => {
  try {
    await connectDB();
    
    const PlantSlot = (await import('./models/slots.model.js')).default;
    const Order = (await import('./models/order.model.js')).default;
    
    const watermelonId = new mongoose.Types.ObjectId('691054dffba6fb380f8d57b3');
    const year = 2025;
    
    console.log('\n🔍 Checking Watermelon Slot Values (Year 2025)...\n');
    
    // Get all slots for watermelon in 2025
    const plantSlots = await PlantSlot.find({
      plantId: watermelonId,
      year: year
    });
    
    if (plantSlots.length === 0) {
      console.log('❌ No slots found for Watermelon in year 2025');
      await mongoose.connection.close();
      return;
    }
    
    let totalPlants = 0;
    let totalBookedPlants = 0;
    let totalAvailablePlants = 0;
    let slotCount = 0;
    
    plantSlots.forEach(plantSlot => {
      plantSlot.subtypeSlots?.forEach(subtypeSlot => {
        subtypeSlot.slots?.forEach(slot => {
          slotCount++;
          totalPlants += slot.totalPlants || 0;
          totalBookedPlants += slot.totalBookedPlants || 0;
          totalAvailablePlants += slot.availablePlants || 0;
        });
      });
    });
    
    console.log(`📊 Slot Statistics (Year ${year}):`);
    console.log(`   - Total slots: ${slotCount}`);
    console.log(`   - Total totalPlants: ${totalPlants}`);
    console.log(`   - Total totalBookedPlants: ${totalBookedPlants}`);
    console.log(`   - Total availablePlants (stored): ${totalAvailablePlants}`);
    console.log(`\n💡 API Calculation:`);
    console.log(`   The API endpoint /api/v1/slots/subtyps calculates:`);
    console.log(`   availablePlants = totalPlants - totalBookedPlants`);
    console.log(`   availablePlants = ${totalPlants} - ${totalBookedPlants} = ${totalPlants - totalBookedPlants}`);
    console.log(`\n📊 Expected API Response:`);
    console.log(`   overallTotals.totalPlants: ${totalPlants}`);
    console.log(`   overallTotals.totalBookedPlants: ${totalBookedPlants}`);
    console.log(`   calculated availablePlants: ${totalPlants - totalBookedPlants}`);
    
    // Also check if there are any orders linked to watermelon slots
    const orders = await Order.find({
      plantName: watermelonId
    }).select('bookingSlot numberOfPlants orderStatus').limit(10);
    
    console.log(`\n📋 Orders linked to Watermelon:`);
    console.log(`   - Total orders: ${await Order.countDocuments({ plantName: watermelonId })}`);
    if (orders.length > 0) {
      console.log(`   - Sample orders:`);
      orders.forEach((order, idx) => {
        console.log(`      ${idx + 1}. Order ID: ${order.orderId}, Plants: ${order.numberOfPlants}, Status: ${order.orderStatus}, Slot: ${order.bookingSlot}`);
      });
    }
    
    console.log('\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed');
    process.exit(0);
  }
};

checkWatermelonValues();





