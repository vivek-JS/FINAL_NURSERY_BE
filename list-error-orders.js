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

const listErrorOrders = async () => {
  try {
    await connectDB();
    
    const ErrorfulOrder = (await import('./models/errorfulOrder.model.js')).default;
    
    console.log('\n📋 Error Orders List');
    console.log('═══════════════════════════════════════════════\n');
    
    // Get all errorful orders sorted by creation date (newest first)
    const errorOrders = await ErrorfulOrder.find({})
      .sort({ createdAt: -1 })
      .lean();
    
    if (errorOrders.length === 0) {
      console.log('✅ No error orders found. All imports were successful!');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`📊 Total Error Orders: ${errorOrders.length}\n`);
    
    // Group by error type
    const errorTypeGroups = {};
    errorOrders.forEach(order => {
      const errorType = order.errorType || 'UNKNOWN';
      if (!errorTypeGroups[errorType]) {
        errorTypeGroups[errorType] = [];
      }
      errorTypeGroups[errorType].push(order);
    });
    
    console.log('📊 Error Types Breakdown:');
    Object.entries(errorTypeGroups).forEach(([type, orders]) => {
      console.log(`   ${type}: ${orders.length}`);
    });
    console.log();
    
    // List all error orders
    errorOrders.forEach((order, index) => {
      console.log(`${'='.repeat(60)}`);
      console.log(`Error Order #${index + 1}`);
      console.log(`${'='.repeat(60)}`);
      console.log(`Row Number: ${order.rowNumber}`);
      console.log(`Booking Number: ${order.bookingNumber || 'N/A'}`);
      console.log(`Parsed Order ID: ${order.parsedOrderId || 'N/A'}`);
      console.log(`Error Type: ${order.errorType || 'UNKNOWN'}`);
      console.log(`Error Message: ${order.errorMessage}`);
      console.log(`Source File: ${order.sourceFilename || 'N/A'}`);
      console.log(`Import Batch ID: ${order.importBatchId || 'N/A'}`);
      console.log(`Created At: ${order.createdAt ? new Date(order.createdAt).toLocaleString() : 'N/A'}`);
      console.log(`Is Resolved: ${order.isResolved ? 'Yes' : 'No'}`);
      console.log(`Retry Attempts: ${order.retryAttempts || 0}`);
      console.log(`Successfully Imported: ${order.successfullyImported ? 'Yes' : 'No'}`);
      
      if (order.rawData && typeof order.rawData === 'object') {
        console.log(`\n📋 Raw Excel Data:`);
        const rawData = order.rawData;
        
        // Helper function to get value safely
        const getValue = (key, altKeys = []) => {
          if (rawData[key]) return rawData[key];
          for (const altKey of altKeys) {
            if (rawData[altKey]) return rawData[altKey];
          }
          return 'N/A';
        };
        
        console.log(`   Name: ${getValue('Name')}`);
        console.log(`   Mobile: ${getValue('Mobile No.', ['Mobile No', 'Mobile'])}`);
        console.log(`   Crop: ${getValue('Crop')}`);
        console.log(`   Variety: ${getValue('Variety')}`);
        console.log(`   Plant Qty: ${getValue('Plant Qty.', ['Plant Qty', 'Plant Qty'])}`);
        console.log(`   Rate: ${getValue('Rate')}`);
        console.log(`   Expected Del. Date: ${getValue('Expected\nDel.\nDate', ['Expected Del. Date', 'Expected Del Date'])}`);
        console.log(`   Del. Y/N: ${getValue('Del.\nY/N', ['Del. Y/N', 'Del Y/N'])}`);
        console.log(`   Address: ${getValue('Address')}`);
        console.log(`   Taluka: ${getValue('Taluka')}`);
        console.log(`   District: ${getValue('District')}`);
        console.log(`   Advance Amt: ${getValue('Advance\nAmt.', ['Advance Amt.', 'Advance Amt'])}`);
        console.log(`   Media: ${getValue('Media')}`);
      }
      
      if (order.resolutionNotes) {
        console.log(`\n💬 Resolution Notes: ${order.resolutionNotes}`);
      }
      
      if (order.resolvedAt) {
        console.log(`\n✅ Resolved At: ${new Date(order.resolvedAt).toLocaleString()}`);
      }
      
      console.log();
    });
    
    // Summary table
    console.log('\n' + '='.repeat(60));
    console.log('📊 SUMMARY TABLE');
    console.log('='.repeat(60));
    console.log('Row | Booking No. | Crop | Variety | Error Type | Error Message');
    console.log('-'.repeat(60));
    
    errorOrders.forEach(order => {
      const rawData = order.rawData || {};
      const crop = rawData.Crop || 'N/A';
      const variety = rawData.Variety || 'N/A';
      const bookingNo = order.bookingNumber || 'N/A';
      const errorType = order.errorType || 'UNKNOWN';
      const errorMsg = order.errorMessage?.substring(0, 40) || 'N/A';
      
      console.log(`${String(order.rowNumber).padEnd(4)} | ${String(bookingNo).padEnd(12)} | ${String(crop).padEnd(6)} | ${String(variety).padEnd(9)} | ${String(errorType).padEnd(11)} | ${errorMsg}`);
    });
    
    console.log('\n' + '='.repeat(60));
    console.log(`Total: ${errorOrders.length} error orders`);
    console.log(`Resolved: ${errorOrders.filter(o => o.isResolved).length}`);
    console.log(`Unresolved: ${errorOrders.filter(o => !o.isResolved).length}`);
    console.log(`Successfully Imported After Retry: ${errorOrders.filter(o => o.successfullyImported).length}`);
    
  } catch (error) {
    console.error('❌ Error:', error);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
    process.exit(0);
  }
};

listErrorOrders();





