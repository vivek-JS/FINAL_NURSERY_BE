import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import XLSX from 'xlsx';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
};

// Parse date from MM/DD/YY format
const parseDate = (dateStr) => {
  if (!dateStr) return null;
  
  if (typeof dateStr === 'string' && dateStr.includes('/')) {
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      const month = parseInt(parts[0]);
      const day = parseInt(parts[1]);
      const year = parseInt(parts[2]);
      const fullYear = year > 30 ? 1900 + year : 2000 + year;
      return new Date(fullYear, month - 1, day);
    }
  }
  
  return new Date(dateStr);
};

const normalizeDate = (date) => {
  if (!date) return null;
  const normalized = new Date(date);
  normalized.setUTCHours(0, 0, 0, 0);
  return normalized;
};

const shiftDate = (date, days) => {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
};

const findSlot = async (deliveryDate, plantType, plantSubtype) => {
  const PlantSlot = (await import('./models/slots.model.js')).default;
  
  const year = deliveryDate.getFullYear();
  const normalizedDeliveryDate = normalizeDate(deliveryDate);
  
  const PlantCms = (await import('./models/plantCms.model.js')).default;
  const plant = await PlantCms.findOne({ name: plantType });
  if (!plant) throw new Error(`Plant ${plantType} not found`);
  
  const subtype = plant.subtypes.find(st => st.name === plantSubtype);
  if (!subtype) throw new Error(`Subtype ${plantSubtype} not found`);
  
  const slotDocs = await PlantSlot.find({ 
    plantId: plant._id,
    year: year 
  });
  
  const candidateOffsets = [0, -7, 7, -14, 14];
  const attemptedOffsets = [];

  for (const offset of candidateOffsets) {
    const targetDate = offset === 0 ? normalizedDeliveryDate : normalizeDate(shiftDate(normalizedDeliveryDate, offset));
    attemptedOffsets.push(offset);

    for (const slotDoc of slotDocs) {
      for (const st of slotDoc.subtypeSlots) {
        if (st.subtypeId.toString() === subtype._id.toString()) {
          for (const slot of st.slots) {
            const slotStart = slot.startDay.split('-').reverse().join('-');
            const slotEnd = slot.endDay.split('-').reverse().join('-');
            const slotStartDate = new Date(slotStart + 'T00:00:00Z');
            const slotEndDate = new Date(slotEnd + 'T00:00:00Z');
            
            if (targetDate >= slotStartDate && targetDate <= slotEndDate) {
              return {
                slot,
                appliedOffset: offset,
                matchedDate: targetDate
              };
            }
          }
        }
      }
    }
  }
  
  throw new Error(`No slot found for ${plantSubtype} (attempted offsets: ${attemptedOffsets.join(', ')})`);
};

const importBooking = async () => {
  await connectDB();
  
  const Order = (await import('./models/order.model.js')).default;
  const Farmer = (await import('./models/farmer.model.js')).default;
  const User = (await import('./models/user.model.js')).default;
  const PlantCms = (await import('./models/plantCms.model.js')).default;
  
  try {
    console.log('\n📖 Reading Excel data...\n');
    
    const { stdout } = await execAsync('python3 read-and-import-booking.py', {
      cwd: __dirname
    });
    
    const rows = JSON.parse(stdout);
    const excelRowOffset = 2; // Excel data rows begin at row index 2
    const importLimit = rows.length;
    console.log(`📦 Importing ${importLimit} orders from Excel...\n`);
    
    const results = { success: 0, failed: 0, errors: [] };
    const summary = {
      invalidPhoneNumbers: 0,
      slotFallbacks: []
    };
    
    // Get the highest orderId and start from there + 1 for system-generated IDs
    const highestOrder = await Order.findOne().sort({ orderId: -1 });
    let systemOrderId = highestOrder ? highestOrder.orderId + 1 : 100000;
    
    // Track used IDs to avoid duplicates
    const usedOrderIds = new Set();
    
    for (let i = 0; i < importLimit; i++) {
      const row = rows[i];
      const excelRowNumber = excelRowOffset + i;
      
      if ((i + 1) % 100 === 0 || i === importLimit - 1) {
        console.log(`📊 Progress: ${i + 1}/${importLimit} (${results.success} success, ${results.failed} failed)`);
      }
      
      try {
        // Required fields validation
        if (!row['Name'] || !row['Date'] || !row['Expected Del. Date'] || 
            !row['Crop'] || !row['Variety'] || !row['Plant Qty.']) {
          results.failed++;
          results.errors.push({
            row: excelRowNumber,
            name: row['Name'] || 'Unknown',
            error: 'Missing required fields',
            data: row
          });
          continue;
        }
        
        // Clean mobile number
        const rawMobile = row['Mobile No.'];
        let formattedMobile = rawMobile !== undefined && rawMobile !== null
          ? String(rawMobile).trim()
          : '';

        const primaryDigits = [];
        const secondaryDigits = [];

        const parts = formattedMobile.split(/[\/|,]+/).map(part => part.trim()).filter(Boolean);
        if (parts.length > 0) {
          const primaryPart = parts[0].replace(/\D/g, '');
          if (primaryPart.length >= 10) {
            primaryDigits.push(primaryPart.slice(-10));
          } else if (primaryPart.length > 0) {
            primaryDigits.push(primaryPart);
          }
        }
        if (parts.length > 1) {
          const secondaryPart = parts[1].replace(/\D/g, '');
          if (secondaryPart.length >= 10) {
            secondaryDigits.push(secondaryPart.slice(-10));
          } else if (secondaryPart.length > 0) {
            secondaryDigits.push(secondaryPart);
          }
        }

        let normalizedMobile = null;
        let secondaryMobile = null;
        let isInvalidPhone = false;

        if (primaryDigits.length === 0) {
          isInvalidPhone = true;
          summary.invalidPhoneNumbers++;
        } else if (primaryDigits[0].length === 10) {
          normalizedMobile = primaryDigits[0];
        } else if (primaryDigits[0].length > 0) {
          isInvalidPhone = true;
          summary.invalidPhoneNumbers++;
        }

        if (secondaryDigits.length > 0) {
          const secondary = secondaryDigits[0];
          if (secondary.length === 10) {
            secondaryMobile = secondary;
          } else {
            isInvalidPhone = true;
            summary.invalidPhoneNumbers++;
          }
        }
        
        const farmerQuery = normalizedMobile
          ? { mobileNumber: Number(normalizedMobile) }
          : {
              name: row['Name'],
              village: (row['Address'] || '').split(',')[0] || 'Unknown',
              taluka: row['Taluka'] || 'Unknown',
              district: row['District'] || 'Unknown'
            };
        
        // Find or create farmer
        let farmer = await Farmer.findOne(farmerQuery);
        if (!farmer) {
          farmer = await Farmer.create({
            name: row['Name'],
            mobileNumber: normalizedMobile ? Number(normalizedMobile) : undefined,
            alternateNumber: secondaryMobile ? Number(secondaryMobile) : undefined,
            village: (row['Address'] || '').split(',')[0] || 'Unknown',
            taluka: row['Taluka'] || 'Unknown',
            district: row['District'] || 'Unknown',
            stateName: 'Maharashtra',
            talukaName: row['Taluka'] || 'Unknown',
            districtName: row['District'] || 'Unknown',
            state: 'MH',
            isInvalidPhone: isInvalidPhone,
            originalPhoneNumber: isInvalidPhone ? (formattedMobile || null) : undefined
          });
        } else {
          let updated = false;
          if (normalizedMobile && !farmer.mobileNumber) {
            farmer.mobileNumber = Number(normalizedMobile);
            updated = true;
          }
          if (secondaryMobile && !farmer.alternateNumber) {
            farmer.alternateNumber = Number(secondaryMobile);
            updated = true;
          }
          if (isInvalidPhone && !farmer.isInvalidPhone) {
            farmer.isInvalidPhone = true;
            farmer.originalPhoneNumber = formattedMobile || farmer.originalPhoneNumber || null;
            updated = true;
          }
          if (updated) {
            await farmer.save();
          }
        }
        
        // Find or create sales person
        const salesPersonName = row['Refrence'] || row['Order By'] || 'Default Sales';
        let salesPerson = await User.findOne({ name: salesPersonName, jobTitle: 'SALES' });
        if (!salesPerson) {
          const dummyPhone = `9999999${Math.floor(1000 + Math.random() * 9000)}`;
          salesPerson = await User.create({
            name: salesPersonName,
            phoneNumber: dummyPhone,
            jobTitle: 'SALES',
            password: '12345678',
            role: 'DEALER'
          });
        }
        
        // Parse dates
        const bookingDate = parseDate(row['Date']);
        const deliveryDate = parseDate(row['Expected Del. Date']);
        
        // Find plant
        const plant = await PlantCms.findOne({ name: row['Crop'] });
        if (!plant) throw new Error(`Plant "${row['Crop']}" not found`);
        
        const subtype = plant.subtypes.find(st => st.name === row['Variety']);
        if (!subtype) throw new Error(`Variety "${row['Variety']}" not found`);
        
        // Find slot
        const { slot: targetSlot, appliedOffset } = await findSlot(deliveryDate, row['Crop'], row['Variety']);
        if (appliedOffset !== 0) {
          summary.slotFallbacks.push({
            row: excelRowNumber,
            offsetDays: appliedOffset,
            name: row['Name'] || 'Unknown'
          });
        }
        
        // Generate orderId from Excel or system
        let newOrderId;
        const bookingNo = row['Booking NO.'];
        
        if (bookingNo && bookingNo !== 0 && bookingNo !== '0') {
          // Use booking number from Excel
          newOrderId = parseInt(bookingNo);
          
          // If already used in this session or exists in DB, use system ID
          if (usedOrderIds.has(newOrderId)) {
            newOrderId = systemOrderId++;
          } else {
            const existingOrder = await Order.findOne({ orderId: newOrderId });
            if (existingOrder) {
              newOrderId = systemOrderId++;
            }
          }
        } else {
          // Generate from system (Booking NO. is 0 or missing)
          newOrderId = systemOrderId++;
        }
        
        // Mark this ID as used
        usedOrderIds.add(newOrderId);
        
        // Create order
        const orderData = {
          orderId: newOrderId,
          farmer: farmer._id,
          salesPerson: salesPerson._id,
          numberOfPlants: parseInt(row['Plant Qty.']) || 0,
          remainingPlants: parseInt(row['Plant Qty.']) || 0,
          plantName: plant._id,
          plantSubtype: subtype._id,
          bookingSlot: targetSlot._id,
          orderBookingDate: bookingDate,
          deliveryDate: deliveryDate,
          rate: parseFloat(row['Rate']) || 0,
          orderStatus: 'PENDING',
          orderPaymentStatus: 'PENDING'
        };
        
        // Add payment
        if (row['Remark']) {
          orderData.orderRemarks = [row['Remark']];
        }
        
        if (row['adv match or not'] && row['Advance Amt.']) {
          const adAmtMode = row['Ad. Amt. Mode'] ? String(row['Ad. Amt. Mode']).trim() : '';
          const bankValue = row['Bank'] ? String(row['Bank']).trim() : '';
          
          const paymentMode = bankValue || adAmtMode || 'CASH';
          
          orderData.payment = [{
            paidAmount: parseFloat(row['Advance Amt.']) || 0,
            modeOfPayment: paymentMode,
            bankName: bankValue || undefined,
            paymentDate: row['Advance Date'] ? parseDate(row['Advance Date']) : new Date(),
            paymentStatus: 'COLLECTED',
            isWalletPayment: false
          }];
        }

        if (isInvalidPhone) {
          orderData.orderRemarks = [
            ...(orderData.orderRemarks || []),
            'Source mobile missing/invalid - farmer flagged for follow-up'
          ];
        }

        if (appliedOffset !== 0) {
          orderData.orderRemarks = [
            ...(orderData.orderRemarks || []),
            `Slot matched using ${appliedOffset} day adjustment`
          ];
        }
        
        await Order.create(orderData);
        results.success++;
        
      } catch (error) {
        results.failed++;
        results.errors.push({
          row: excelRowNumber,
          name: row['Name'] || 'Unknown',
          error: error.message,
          data: row
        });
      }
    }
    
    console.log('\n✅ Import completed!');
    console.log(`📊 Successful: ${results.success}`);
    console.log(`❌ Failed: ${results.failed}`);
    console.log(`ℹ️ Farmers flagged with invalid phones: ${summary.invalidPhoneNumbers}`);
    console.log(`ℹ️ Slot fallbacks applied: ${summary.slotFallbacks.length}`);
    if (summary.slotFallbacks.length > 0) {
      summary.slotFallbacks.slice(0, 5).forEach((entry, index) => {
        console.log(`   ↳ Fallback ${index + 1}: Row ${entry.row} (${entry.name}) offset ${entry.offsetDays} days`);
      });
      if (summary.slotFallbacks.length > 5) {
        console.log(`   ...and ${summary.slotFallbacks.length - 5} more fallbacks`);
      }
    }
    
    if (results.errors.length > 0) {
      console.log('\n❌ Failure reasons:');
      results.errors.slice(0, 25).forEach((info, index) => {
        console.log(`   ${index + 1}. Row ${info.row} (${info.name}) - ${info.error}`);
      });
      
      const errorOutputPath = path.join(__dirname, 'import-failures.json');
      fs.writeFileSync(errorOutputPath, JSON.stringify(results.errors, null, 2));
      console.log(`\n📝 Saved detailed errors to ${errorOutputPath}`);

      const columnOrder = [
        'Date', 'Booking NO.', 'Name', 'Mobile No.', 'Address', 'Taluka', 'District',
        'Advance On Booking Receipts', 'adv match or not', 'Advance Amt.', 'Crop', 'Variety',
        'Media', 'Expected Nursery', 'Plant Qty.', 'Rate', 'Expected Del. Date',
        'Old Del. Date', 'Del. Y/N', 'Actually Del. Date', 'Invoice amount', 'Bal. Amt.',
        'Refrence', 'Order By', 'Ad. Amt. Mode', 'Bank', 'CH No.', 'Advance Date',
        'ADV Y/N', 'CC Y/N', 'Remark'
      ];

      const worksheetData = [
        ['Excel Row', ...columnOrder, 'Error Remark']
      ];

      results.errors.forEach((entry) => {
        const rowValues = columnOrder.map((col) => (entry.data && entry.data[col] !== undefined) ? entry.data[col] : '');
        worksheetData.push([
          entry.row,
          ...rowValues,
          entry.error
        ]);
      });

      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Failed Imports');

      const failureExcelPath = path.join(__dirname, 'import-failures.xlsx');
      XLSX.writeFile(workbook, failureExcelPath);
      console.log(`📝 Saved failure workbook to ${failureExcelPath}`);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.connection.close();
  }
};

importBooking();

