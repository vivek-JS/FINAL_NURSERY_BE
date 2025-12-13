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

const deleteInvalidOrders = async () => {
  try {
    await connectDB();
    
    const ErrorfulOrder = (await import('./models/errorfulOrder.model.js')).default;
    
    console.log('\n🗑️  Deleting Invalid Orders (Errorful Orders)');
    console.log('═══════════════════════════════════════════════\n');
    
    // Count before deletion
    const totalBefore = await ErrorfulOrder.countDocuments();
    const unresolvedBefore = await ErrorfulOrder.countDocuments({ isResolved: false });
    const resolvedBefore = await ErrorfulOrder.countDocuments({ isResolved: true });
    
    console.log('📊 Before Deletion:');
    console.log(`   Total Errorful Orders: ${totalBefore}`);
    console.log(`   Unresolved: ${unresolvedBefore}`);
    console.log(`   Resolved: ${resolvedBefore}\n`);
    
    if (totalBefore === 0) {
      console.log('✅ No invalid orders to delete.');
      await mongoose.connection.close();
      return;
    }
    
    // Delete all errorful orders
    console.log('🗑️  Deleting all invalid orders...');
    const deleteResult = await ErrorfulOrder.deleteMany({});
    
    console.log(`✅ Deleted ${deleteResult.deletedCount} invalid order(s)\n`);
    
    // Verify deletion
    const totalAfter = await ErrorfulOrder.countDocuments();
    
    console.log('📊 After Deletion:');
    console.log(`   Total Errorful Orders: ${totalAfter}`);
    
    if (totalAfter === 0) {
      console.log('\n✅ SUCCESS! All invalid orders have been deleted.');
    } else {
      console.log(`\n⚠️  WARNING: ${totalAfter} orders still remain.`);
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

deleteInvalidOrders();




