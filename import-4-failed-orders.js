import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import XLSX from 'xlsx';
import { importOrdersAndFarmers } from './controllers/excel.serveces.controller.js';

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
    const { generateSlotsForYear } = await import('./controllers/slots.controller.js');
    const moment = (await import('moment')).default;

    console.log('\n🔧 Creating missing slots...');

    // 1. Watermelon Simbha - October 2025
    console.log('\n1. Creating slots for Watermelon Simbha - October 2025');
    const watermelon = await PlantCms.findOne({ name: /watermelon/i });
    if (!watermelon) {
      throw new Error('Watermelon plant not found');
    }
    
    const simbhaSubtype = watermelon.subtypes.find(st => 
      st.name && st.name.toLowerCase().replace(/-/g, '') === 'simbha'
    );
    if (!simbhaSubtype) {
      throw new Error('Simbha subtype not found for Watermelon');
    }

    // Generate slots for 2025
    const slots2025 = generateSlotsForYear(2025, 1); // 1 day slot size for Watermelon
    const slotTemplates = slots2025.map(slot => ({
      ...slot,
      totalPlants: simbhaSubtype.slotCapacity || 100000,
      availablePlants: simbhaSubtype.slotCapacity || 100000,
      buffer: simbhaSubtype.buffer || 0,
      plantReadyDays: 18,
      status: true,
    }));

    // Find or create PlantSlot for 2025
    let plantSlot2025 = await PlantSlot.findOne({
      plantId: watermelon._id,
      year: 2025,
    });

    if (!plantSlot2025) {
      plantSlot2025 = new PlantSlot({
        plantId: watermelon._id,
        year: 2025,
        subtypeSlots: [],
      });
    }

    // Find or create subtype slot entry
    let subtypeSlot = plantSlot2025.subtypeSlots.find(
      ss => ss.subtypeId.toString() === simbhaSubtype._id.toString()
    );

    if (!subtypeSlot) {
      plantSlot2025.subtypeSlots.push({
        subtypeId: simbhaSubtype._id,
        slots: slotTemplates,
      });
    } else {
      // Add missing slots if any
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
    console.log('   ✅ Watermelon Simbha slots created/updated for 2025');

    // 2. Papaya 15 no - November 2025
    console.log('\n2. Creating slots for Papaya 15 no - November 2025');
    const papaya = await PlantCms.findOne({ name: /papaya/i });
    if (!papaya) {
      throw new Error('Papaya plant not found');
    }
    
    const papaya15noSubtype = papaya.subtypes.find(st => 
      st.name && (st.name.toLowerCase().includes('15') || st.name.toLowerCase().includes('fifteen'))
    );
    if (!papaya15noSubtype) {
      throw new Error('15 no subtype not found for Papaya');
    }

    // Generate slots for 2025
    const papayaSlots2025 = generateSlotsForYear(2025, 7); // 7 day slot size for Papaya
    const papayaSlotTemplates = papayaSlots2025.map(slot => ({
      ...slot,
      totalPlants: papaya15noSubtype.slotCapacity || 100000,
      availablePlants: papaya15noSubtype.slotCapacity || 100000,
      buffer: papaya15noSubtype.buffer || 0,
      plantReadyDays: 40,
      status: true,
    }));

    // Find or create PlantSlot for 2025
    let papayaPlantSlot2025 = await PlantSlot.findOne({
      plantId: papaya._id,
      year: 2025,
    });

    if (!papayaPlantSlot2025) {
      papayaPlantSlot2025 = new PlantSlot({
        plantId: papaya._id,
        year: 2025,
        subtypeSlots: [],
      });
    }

    // Find or create subtype slot entry
    let papayaSubtypeSlot = papayaPlantSlot2025.subtypeSlots.find(
      ss => ss.subtypeId.toString() === papaya15noSubtype._id.toString()
    );

    if (!papayaSubtypeSlot) {
      papayaPlantSlot2025.subtypeSlots.push({
        subtypeId: papaya15noSubtype._id,
        slots: papayaSlotTemplates,
      });
    } else {
      // Add missing slots if any
      const existingSlotDates = new Set(
        papayaSubtypeSlot.slots.map(s => `${s.startDay}-${s.endDay}`)
      );
      
      const newSlots = papayaSlotTemplates.filter(
        s => !existingSlotDates.has(`${s.startDay}-${s.endDay}`)
      );
      
      if (newSlots.length > 0) {
        papayaSubtypeSlot.slots.push(...newSlots);
        papayaSubtypeSlot.slots.sort((a, b) => {
          const aDate = moment(a.startDay, 'DD-MM-YYYY');
          const bDate = moment(b.startDay, 'DD-MM-YYYY');
          return aDate - bDate;
        });
      }
    }

    await papayaPlantSlot2025.save();
    console.log('   ✅ Papaya 15 no slots created/updated for 2025');

    console.log('\n✅ Missing slots created successfully!');
  } catch (error) {
    console.error('❌ Error creating slots:', error);
    throw error;
  }
};

const import4Orders = async () => {
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
    
    // Get the 4 specific rows (indices 664, 668, 669, 681 in 0-based, which are rows 665, 669, 670, 682 in Excel)
    const targetRows = [664, 668, 669, 681];
    const bookingNumbers = ['25-26/B0032', '25-26/B0036', '25-26/B0040', '25-26/B0052'];
    
    console.log(`\n📋 Extracting 4 specific orders...`);
    const limitedData = targetRows.map(idx => allData[idx]).filter(Boolean);
    
    console.log(`Found ${limitedData.length} rows to import:`);
    limitedData.forEach((row, idx) => {
      console.log(`  ${idx + 1}. Row ${targetRows[idx] + 1}, Booking: ${bookingNumbers[idx] || row['Booking NO.'] || 'N/A'}`);
    });
    
    // Create a new workbook with only these 4 rows
    const newWorkbook = XLSX.utils.book_new();
    const newWorksheet = XLSX.utils.json_to_sheet(limitedData);
    XLSX.utils.book_append_sheet(newWorkbook, newWorksheet, 'BOOKING LIST');
    
    // Convert to buffer
    const limitedBuffer = XLSX.write(newWorkbook, { type: 'buffer', bookType: 'xlsx' });
    
    console.log(`\n🚀 Starting import of 4 orders...`);
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
import4Orders();

