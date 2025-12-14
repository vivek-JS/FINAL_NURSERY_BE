import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment';
import XLSX from 'xlsx';
import path from 'path';
import { fileURLToPath } from 'url';

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
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

const generatePrimarySowingReport = async () => {
  try {
    const { default: Sowing } = await import('./models/sowing.model.js');
    const { default: PlantCms } = await import('./models/plantCms.model.js');
    const { default: PlantSlot } = await import('./models/slots.model.js');

    await connectDB();

    console.log('\n📊 Generating Primary Sowing Report...\n');

    // Fetch all PRIMARY sowings
    const sowings = await Sowing.find({
      sowingLocation: 'PRIMARY'
    })
      .populate('plantId', 'name')
      .populate('subtypeId', 'name')
      .sort({ sowingDate: 1, plantName: 1, subtypeName: 1 });

    console.log(`📦 Found ${sowings.length} PRIMARY sowing records\n`);

    if (sowings.length === 0) {
      console.log('⚠️  No PRIMARY sowing records found.');
      return;
    }

    // Group by date for report
    const reportByDate = {};
    const reportByPlant = {};
    let totalPlants = 0;

    sowings.forEach(sowing => {
      const date = sowing.sowingDate || moment(sowing.createdAt).format('DD-MM-YYYY');
      const plantName = sowing.plantName || (sowing.plantId?.name || 'Unknown');
      const subtypeName = sowing.subtypeName || (sowing.subtypeId?.name || 'Unknown');
      const qty = sowing.primarySowed || sowing.totalQuantityRequired || sowing.totalSowed || 0;

      // Group by date
      if (!reportByDate[date]) {
        reportByDate[date] = [];
      }
      reportByDate[date].push({
        date,
        plant: plantName,
        variety: subtypeName,
        qty: qty,
        slotId: sowing.slotId,
        expectedReady: sowing.expectedReadyDate,
        status: sowing.status
      });

      // Group by plant/variety
      const key = `${plantName} - ${subtypeName}`;
      if (!reportByPlant[key]) {
        reportByPlant[key] = {
          plant: plantName,
          variety: subtypeName,
          entries: [],
          totalQty: 0
        };
      }
      reportByPlant[key].entries.push({
        date,
        qty,
        slotId: sowing.slotId
      });
      reportByPlant[key].totalQty += qty;

      totalPlants += qty;
    });

    // Console Report
    console.log('='.repeat(80));
    console.log('📊 PRIMARY SOWING REPORT');
    console.log('='.repeat(80));
    console.log(`\n📅 Date Range: ${Object.keys(reportByDate).sort()[0]} to ${Object.keys(reportByDate).sort().reverse()[0]}`);
    console.log(`📦 Total Records: ${sowings.length}`);
    console.log(`🌱 Total Plants Sowed: ${totalPlants.toLocaleString()}\n`);

    // Date-wise summary
    console.log('📅 DATE-WISE SUMMARY:');
    console.log('-'.repeat(80));
    const sortedDates = Object.keys(reportByDate).sort();
    sortedDates.forEach(date => {
      const entries = reportByDate[date];
      const dateTotal = entries.reduce((sum, e) => sum + e.qty, 0);
      console.log(`\n📅 ${moment(date, 'DD-MM-YYYY').format('DD-MMM-YYYY')} (${entries.length} entries, ${dateTotal.toLocaleString()} plants):`);
      entries.forEach(entry => {
        console.log(`   • ${entry.plant} - ${entry.variety}: ${entry.qty.toLocaleString()} plants`);
      });
    });

    // Plant-wise summary
    console.log('\n\n🌱 PLANT-WISE SUMMARY:');
    console.log('-'.repeat(80));
    const sortedPlants = Object.keys(reportByPlant).sort();
    sortedPlants.forEach(key => {
      const data = reportByPlant[key];
      console.log(`\n🌱 ${data.plant} - ${data.variety}:`);
      console.log(`   Total: ${data.totalQty.toLocaleString()} plants across ${data.entries.length} entries`);
      console.log(`   Dates: ${data.entries.map(e => e.date).join(', ')}`);
    });

    // Generate Excel Report
    console.log('\n\n📝 Generating Excel report...');

    // Prepare data for Excel
    const excelData = [
      ['Date', 'Plant', 'Variety', 'Sowing Quantity', 'Expected Ready Date', 'Status', 'Slot ID']
    ];

    sortedDates.forEach(date => {
      reportByDate[date].forEach(entry => {
        excelData.push([
          moment(date, 'DD-MM-YYYY').format('DD-MMM-YYYY'),
          entry.plant,
          entry.variety,
          entry.qty,
          entry.expectedReady || 'N/A',
          entry.status || 'READY',
          entry.slotId || 'N/A'
        ]);
      });
    });

    // Add summary sheet
    const summaryData = [
      ['Report Generated', moment().format('DD-MMM-YYYY HH:mm')],
      ['Total Records', sowings.length],
      ['Total Plants Sowed', totalPlants],
      [''],
      ['Plant', 'Variety', 'Total Quantity', 'Entries']
    ];

    sortedPlants.forEach(key => {
      const data = reportByPlant[key];
      summaryData.push([
        data.plant,
        data.variety,
        data.totalQty,
        data.entries.length
      ]);
    });

    // Create workbook
    const workbook = XLSX.utils.book_new();

    // Main data sheet
    const worksheet = XLSX.utils.aoa_to_sheet(excelData);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Primary Sowings');

    // Summary sheet
    const summaryWorksheet = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(workbook, summaryWorksheet, 'Summary');

    // Save file
    const fileName = `primary-sowing-report-${moment().format('YYYY-MM-DD-HHmm')}.xlsx`;
    const filePath = path.join(__dirname, fileName);
    XLSX.writeFile(workbook, filePath);

    console.log(`✅ Excel report saved to: ${filePath}`);
    console.log('\n✅ Report generation completed!\n');

  } catch (error) {
    console.error('\n❌ Error generating report:', error);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed\n');
    process.exit(0);
  }
};

generatePrimarySowingReport();





