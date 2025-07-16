import mongoose from 'mongoose';
import dotenv from 'dotenv';
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

// Load environment variables
dotenv.config();

// Connect to MongoDB
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URL || 'mongodb://localhost:27017/nursery-management');
    console.log('MongoDB Connected:', conn.connection.host);
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
    process.exit(1);
  }
};

// Import the Order model
import Order from './models/order.model.js';

// Function to extract order ID from booking number
const extractOrderId = (bookingNo) => {
  if (!bookingNo) return null;
  
  const bookingStr = bookingNo.toString();
  
  // Handle format like "24-25/B0237" -> extract "237"
  const match = bookingStr.match(/\/B(\d+)/);
  if (match) {
    return parseInt(match[1]);
  }
  
  // Handle format like "B0237" -> extract "237"
  const match2 = bookingStr.match(/B(\d+)/);
  if (match2) {
    return parseInt(match2[1]);
  }
  
  // Handle plain numbers
  const numericMatch = bookingStr.match(/(\d+)/);
  if (numericMatch) {
    return parseInt(numericMatch[1]);
  }
  
  return null;
};

// Function to update orders with sales person from Excel
const updateOrdersWithSalesPerson = async () => {
  try {
    await connectDB();

    // Path to the Excel file
    const excelFilePath = path.join(process.cwd(), 'deployment', 'Booking Sep To Feb.xlsx');
    
    // Check if file exists
    if (!fs.existsSync(excelFilePath)) {
      console.error('❌ Excel file not found at:', excelFilePath);
      console.log('Please make sure the file "Booking Sep To Feb.xlsx" is in the deployment folder');
      return;
    }

    console.log('📖 Reading Excel file:', excelFilePath);

    // Read the Excel file
    const workbook = XLSX.readFile(excelFilePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    console.log(`📊 Found ${data.length} rows in the Excel file`);

    // Get all columns
    const firstRow = data[0];
    const columns = Object.keys(firstRow);
    
    console.log('📋 Available columns:', columns);

    // Find required columns
    const bookingNoColumn = columns.find(col => col === 'Booking NO.' || col === 'Booking No.' || col === 'Booking No');
    const refrenceColumn = columns.find(col => col === 'Refrence');
    const orderByColumn = columns.find(col => col === 'Order\r\nBy' || col === 'Order By');

    if (!bookingNoColumn) {
      console.error('❌ Booking NO. column not found in Excel file');
      console.log('Available columns:', columns);
      return;
    }

    if (!refrenceColumn) {
      console.error('❌ Refrence column not found in Excel file');
      console.log('Available columns:', columns);
      return;
    }

    console.log(`✅ Found columns:`);
    console.log(`   - Booking NO.: "${bookingNoColumn}"`);
    console.log(`   - Refrence: "${refrenceColumn}"`);
    if (orderByColumn) {
      console.log(`   - Order By: "${orderByColumn}"`);
    }
    console.log('');

    // Create a mapping of order IDs to sales persons
    const orderIdToSalesPerson = {};
    let validMappings = 0;
    let invalidMappings = 0;

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const bookingNo = row[bookingNoColumn];
      const refrence = row[refrenceColumn];

      if (bookingNo && refrence) {
        const orderId = extractOrderId(bookingNo);
        if (orderId) {
          orderIdToSalesPerson[orderId] = refrence;
          validMappings++;
          console.log(`📋 Mapped: ${bookingNo} (ID: ${orderId}) → ${refrence}`);
        } else {
          invalidMappings++;
          console.log(`❌ Could not extract order ID from: ${bookingNo}`);
        }
      } else {
        invalidMappings++;
      }
    }

    console.log(`\n📋 Created ${validMappings} valid order-to-sales-person mappings`);
    console.log(`❌ Skipped ${invalidMappings} rows with missing/invalid data`);
    console.log('');

    // Get all orders from database
    console.log('🔍 Fetching all orders from database...');
    const allOrders = await Order.find({});
    console.log(`📊 Found ${allOrders.length} orders in database`);

    // Update orders with sales person information
    let updatedCount = 0;
    let notFoundCount = 0;
    let alreadyUpdatedCount = 0;
    const errors = [];

    for (const order of allOrders) {
      try {
        const orderId = order.orderId || order._id.toString();
        
        // Check if we have a mapping for this order
        if (orderIdToSalesPerson[orderId]) {
          const salesPerson = orderIdToSalesPerson[orderId];
          
          // Check if order already has a sales person
          if (order.orderBy && order.orderBy.trim() !== '') {
            alreadyUpdatedCount++;
            console.log(`⏭️  Order ${orderId} already has sales person: ${order.orderBy}`);
            continue;
          }

          // Update the order with sales person
          order.orderBy = salesPerson;
          await order.save();
          
          console.log(`✅ Updated order ${orderId} with sales person: ${salesPerson}`);
          updatedCount++;

        } else {
          notFoundCount++;
          console.log(`❌ No mapping found for order: ${orderId}`);
        }

      } catch (error) {
        errors.push({
          orderId: order.orderId || order._id.toString(),
          error: error.message
        });
        console.error(`❌ Error updating order ${order.orderId}:`, error.message);
      }
    }

    // Print summary
    console.log('\n📋 Update Summary:');
    console.log(`✅ Orders updated with sales person: ${updatedCount}`);
    console.log(`⏭️  Orders already had sales person: ${alreadyUpdatedCount}`);
    console.log(`❌ Orders not found in Excel: ${notFoundCount}`);
    console.log(`📊 Total orders processed: ${allOrders.length}`);
    
    if (errors.length > 0) {
      console.log('\n❌ Errors encountered:');
      errors.forEach(error => {
        console.log(`   Order ${error.orderId}: ${error.error}`);
      });
    }

    // Show some sample mappings
    console.log('\n📋 Sample Order-to-Sales-Person Mappings:');
    const sampleMappings = Object.entries(orderIdToSalesPerson).slice(0, 10);
    sampleMappings.forEach(([orderId, salesPerson]) => {
      console.log(`   Order ${orderId} → ${salesPerson}`);
    });

    if (Object.keys(orderIdToSalesPerson).length > 10) {
      console.log(`   ... and ${Object.keys(orderIdToSalesPerson).length - 10} more mappings`);
    }

    console.log('\n🎉 Order update process completed!');

  } catch (error) {
    console.error('❌ Error updating orders:', error);
  } finally {
    mongoose.connection.close();
    console.log('Database connection closed');
  }
};

// Run the script
updateOrdersWithSalesPerson(); 