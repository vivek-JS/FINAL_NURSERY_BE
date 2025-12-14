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

const checkInvalidOrders = async () => {
  try {
    await connectDB();
    
    const ErrorfulOrder = (await import('./models/errorfulOrder.model.js')).default;
    
    console.log('\n📊 Checking Invalid/Failed Orders (Errorful Orders)');
    console.log('═══════════════════════════════════════════════\n');
    
    // Get statistics
    const total = await ErrorfulOrder.countDocuments();
    const unresolved = await ErrorfulOrder.countDocuments({ isResolved: false });
    const resolved = await ErrorfulOrder.countDocuments({ isResolved: true });
    const successfullyImported = await ErrorfulOrder.countDocuments({ successfullyImported: true });
    
    console.log('📈 Statistics:');
    console.log(`   Total Errorful Orders: ${total}`);
    console.log(`   Unresolved: ${unresolved}`);
    console.log(`   Resolved: ${resolved}`);
    console.log(`   Successfully Imported After Retry: ${successfullyImported}\n`);
    
    if (total === 0) {
      console.log('✅ No invalid orders stored. All imports were successful!');
      await mongoose.connection.close();
      return;
    }
    
    // Get error type breakdown
    const errorTypeStats = await ErrorfulOrder.aggregate([
      {
        $group: {
          _id: '$errorType',
          count: { $sum: 1 }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);
    
    console.log('📋 Error Type Breakdown:');
    errorTypeStats.forEach(stat => {
      console.log(`   ${stat._id || 'UNKNOWN'}: ${stat.count}`);
    });
    console.log();
    
    // Get recent unresolved orders
    console.log('📋 Recent Unresolved Orders (Last 10):');
    console.log('─────────────────────────────────────────────\n');
    
    const unresolvedOrders = await ErrorfulOrder.find({
      isResolved: false
    })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();
    
    if (unresolvedOrders.length === 0) {
      console.log('✅ All invalid orders have been resolved!\n');
    } else {
      unresolvedOrders.forEach((order, idx) => {
        console.log(`Invalid Order ${idx + 1}:`);
        console.log('──────────────────────────────────────────');
        console.log(`Row Number: ${order.rowNumber}`);
        console.log(`Booking Number: ${order.bookingNumber || 'N/A'}`);
        console.log(`Error Type: ${order.errorType || 'UNKNOWN'}`);
        console.log(`Error Message: ${order.errorMessage}`);
        console.log(`Source File: ${order.sourceFilename || 'N/A'}`);
        console.log(`Import Batch ID: ${order.importBatchId || 'N/A'}`);
        console.log(`Created At: ${order.createdAt ? new Date(order.createdAt).toLocaleString() : 'N/A'}`);
        console.log(`Retry Attempts: ${order.retryAttempts || 0}`);
        
        if (order.rawData && typeof order.rawData === 'object') {
          console.log(`\n   Raw Data (from Excel):`);
          const rawData = order.rawData;
          if (rawData.Name) console.log(`      Name: ${rawData.Name}`);
          if (rawData['Mobile No.']) console.log(`      Mobile: ${rawData['Mobile No.']}`);
          if (rawData.Crop) console.log(`      Crop: ${rawData.Crop}`);
          if (rawData.Variety) console.log(`      Variety: ${rawData.Variety}`);
          if (rawData['Expected\nDel.\nDate']) console.log(`      Expected Del. Date: ${rawData['Expected\nDel.\nDate']}`);
          if (rawData['Plant Qty.']) console.log(`      Plant Qty: ${rawData['Plant Qty.']}`);
        }
        console.log();
      });
    }
    
    // Get import batch IDs
    const batchStats = await ErrorfulOrder.aggregate([
      {
        $group: {
          _id: '$importBatchId',
          count: { $sum: 1 },
          unresolved: {
            $sum: { $cond: [{ $eq: ['$isResolved', false] }, 1, 0] }
          }
        }
      },
      {
        $sort: { count: -1 }
      },
      {
        $limit: 5
      }
    ]);
    
    if (batchStats.length > 0) {
      console.log('📦 Import Batch Statistics (Top 5):');
      batchStats.forEach(batch => {
        console.log(`   Batch: ${batch._id || 'N/A'}`);
        console.log(`      Total Errors: ${batch.count}`);
        console.log(`      Unresolved: ${batch.unresolved}`);
        console.log();
      });
    }
    
    console.log('═══════════════════════════════════════════════');
    console.log('💡 How Invalid Orders Work:');
    console.log('─────────────────────────────────────────────');
    console.log('1. When an order fails to import during Excel import,');
    console.log('   it is automatically saved to ErrorfulOrder collection');
    console.log('');
    console.log('2. Each invalid order stores:');
    console.log('   - Complete raw Excel row data');
    console.log('   - Row number from Excel');
    console.log('   - Error message explaining the failure');
    console.log('   - Error type (VALIDATION_ERROR, SLOT_ERROR, etc.)');
    console.log('   - Import batch ID for tracking');
    console.log('');
    console.log('3. You can view/resolve invalid orders via:');
    console.log('   GET /api/v1/excel/errorful-orders');
    console.log('');
    console.log('4. Invalid orders can be marked as resolved and');
    console.log('   tracked if successfully imported after fixing issues');
    console.log('');
    
  } catch (error) {
    console.error('❌ Error:', error);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed');
    process.exit(0);
  }
};

checkInvalidOrders();





