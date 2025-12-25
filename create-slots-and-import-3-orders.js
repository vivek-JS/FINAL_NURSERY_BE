import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import XLSX from 'xlsx';
import { importOrdersAndFarmers } from './controllers/excel.serveces.controller.js';
import { generateSlotsForYear } from './controllers/slots.controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

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

const createMissingSlots = async () => {
  try {
    const PlantCms = (await import('./models/plantCms.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    const moment = (await import('moment')).default;

    console.log('\n🔧 Creating missing slots for November 2025...');

    // Read Excel to find which plants/varieties need slots
    const filePath = path.join(__dirname, 'fetch-excel', 'new_booking.xlsx');
    const fileBuffer = fs.readFileSync(filePath);
    const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false });
    const worksheet = workbook.Sheets['BOOKING LIST'];
    const allData = XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: true });

    const rows701_800 = allData.slice(700, 800);
    const bookingNumbers = ['25-26/B0096', '25-26/B0097', '25-26/B0103'];
    
    const neededSlots = new Map(); // Map: "plantName::varietyName" -> { plantName, varietyName }

    rows701_800.forEach((row) => {
      const bookingNo = (row['Booking NO.'] || row['Booking\r\nNO.'] || '').toString();
      if (bookingNumbers.includes(bookingNo)) {
        const crop = row['Crop'] || '';
        const variety = row['Variety'] || '';
        if (crop && variety) {
          const key = `${crop}::${variety}`;
          if (!neededSlots.has(key)) {
            neededSlots.set(key, { plantName: crop, varietyName: variety });
          }
        }
      }
    });

    console.log(`\n📋 Found ${neededSlots.size} plant/variety combinations needing slots:`);
    neededSlots.forEach(({ plantName, varietyName }) => {
      console.log(`   - ${plantName} -> ${varietyName}`);
    });

    // Create slots for each plant/variety
    for (const [key, { plantName, varietyName }] of neededSlots.entries()) {
      console.log(`\n🔧 Creating slots for ${plantName} -> ${varietyName} (November 2025)...`);
      
      const plant = await PlantCms.findOne({ name: new RegExp(`^${plantName}$`, 'i') });
      if (!plant) {
        console.log(`   ⚠️  Plant "${plantName}" not found, skipping...`);
        continue;
      }

      // Find subtype (handle case variations)
      const normalizeForComparison = (name) => {
        return (name || '').toString().toLowerCase().replace(/-/g, '').replace(/\s+/g, '');
      };

      const targetVariety = normalizeForComparison(varietyName);
      const subtype = plant.subtypes.find(st => 
        normalizeForComparison(st.name) === targetVariety
      );

      if (!subtype) {
        console.log(`   ⚠️  Variety "${varietyName}" not found for ${plantName}, skipping...`);
        continue;
      }

      // Determine slot size based on plant type
      let slotSize = 7; // Default
      if (plantName.toLowerCase().includes('watermelon')) {
        slotSize = 1;
      } else if (plantName.toLowerCase().includes('papaya')) {
        slotSize = 7;
      } else if (plantName.toLowerCase().includes('banana')) {
        slotSize = 7;
      }

      // Generate slots for November 2025
      const slots2025 = generateSlotsForYear(2025, slotSize);
      
      // Filter to only November slots
      const novemberSlots = slots2025.filter(slot => {
        const slotDate = moment(slot.startDay, 'DD-MM-YYYY');
        return slotDate.month() === 10; // November is month 10 (0-indexed)
      });

      const slotTemplates = novemberSlots.map(slot => ({
        ...slot,
        totalPlants: subtype.slotCapacity || 100000,
        availablePlants: subtype.slotCapacity || 100000,
        buffer: subtype.buffer || 0,
        plantReadyDays: subtype.plantReadyDays || 0,
        status: true,
      }));

      // Find or create PlantSlot for 2025
      let plantSlot2025 = await PlantSlot.findOne({
        plantId: plant._id,
        year: 2025,
      });

      if (!plantSlot2025) {
        plantSlot2025 = new PlantSlot({
          plantId: plant._id,
          year: 2025,
          subtypeSlots: [],
        });
      }

      // Find or create subtype slot entry
      let subtypeSlot = plantSlot2025.subtypeSlots.find(
        ss => ss.subtypeId.toString() === subtype._id.toString()
      );

      if (!subtypeSlot) {
        plantSlot2025.subtypeSlots.push({
          subtypeId: subtype._id,
          slots: slotTemplates,
        });
      } else {
        // Add missing November slots
        const existingSlotDates = new Set(
          subtypeSlot.slots.map(s => `${s.startDay}-${s.endDay}`)
        );
        
        const newSlots = slotTemplates.filter(
          s => !existingSlotDates.has(`${s.startDay}-${s.endDay}`)
        );
        
        if (newSlots.length > 0) {
          subtypeSlot.slots.push(...newSlots);
          subtypeSlot.slots.sort((a, b) => {
            const aDate = moment(a.startDay, 'DD-MM-YYYY');
            const bDate = moment(b.startDay, 'DD-MM-YYYY');
            return aDate - bDate;
          });
        }
      }

      await plantSlot2025.save();
      console.log(`   ✅ Created/updated slots for ${plantName} -> ${varietyName} (November 2025)`);
    }

    console.log('\n✅ Missing slots created successfully!');
  } catch (error) {
    console.error('❌ Error creating slots:', error);
    throw error;
  }
};

const import3Orders = async () => {
  try {
    await connectDB();

    // Create missing slots first
    await createMissingSlots();

    const filePath = path.join(__dirname, 'fetch-excel', 'new_booking.xlsx');
    
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`);
      await mongoose.disconnect();
      return;
    }

    console.log(`\n📄 Reading Excel file: ${filePath}`);
    const fileBuffer = fs.readFileSync(filePath);
    
    const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false });
    const worksheet = workbook.Sheets['BOOKING LIST'];
    const allData = XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: true });
    
    // Find the 3 specific rows by booking number
    const bookingNumbers = ['25-26/B0096', '25-26/B0097', '25-26/B0103'];
    const rows701_800 = allData.slice(700, 800);
    
    const targetRows = [];
    rows701_800.forEach((row, idx) => {
      const bookingNo = (row['Booking NO.'] || row['Booking\r\nNO.'] || '').toString();
      if (bookingNumbers.includes(bookingNo)) {
        targetRows.push(row);
        console.log(`   Found: Row ${701 + idx}, Booking: ${bookingNo}`);
      }
    });
    
    if (targetRows.length === 0) {
      console.log('❌ Could not find the 3 orders in rows 701-800');
      await mongoose.disconnect();
      return;
    }
    
    // Create a new workbook with only these 3 rows
    const newWorkbook = XLSX.utils.book_new();
    const newWorksheet = XLSX.utils.json_to_sheet(targetRows);
    XLSX.utils.book_append_sheet(newWorkbook, newWorksheet, 'BOOKING LIST');
    
    // Convert to buffer
    const limitedBuffer = XLSX.write(newWorkbook, { type: 'buffer', bookType: 'xlsx' });
    
    console.log(`\n🚀 Starting import of 3 orders...`);
    console.log('='.repeat(80));
    
    const results = await importOrdersAndFarmers(limitedBuffer, {
      skipExisting: false,
      autoCreateSalesPersons: true,
    });

    console.log('\n' + '='.repeat(80));
    console.log('📊 IMPORT RESULTS');
    console.log('='.repeat(80));
    
    if (results.summary) {
      console.log(`Total Processed: ${results.summary.totalProcessed || 0}`);
      console.log(`✅ Successful: ${results.summary.successfulImports || 0}`);
      console.log(`❌ Failed: ${results.summary.failedImports || 0}`);
    }

    if (results.success && results.success.length > 0) {
      console.log(`\n✅ Successful Imports:`);
      results.success.forEach((item, idx) => {
        console.log(`   ${idx + 1}. ${item.bookingNo || 'N/A'} - ${item.farmerName || 'Updated'}`);
      });
    }

    if (results.errors && results.errors.length > 0) {
      console.log(`\n❌ Failed Imports:`);
      results.errors.forEach((error, idx) => {
        console.log(`   ${idx + 1}. ${error.bookingNo || 'N/A'}: ${error.error}`);
      });
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ Import process completed!');
    console.log('='.repeat(80) + '\n');

    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB');

  } catch (error) {
    console.error('❌ Error during import:', error);
    console.error(error.stack);
    await mongoose.disconnect();
    process.exit(1);
  }
};

// Main execution
import3Orders();

