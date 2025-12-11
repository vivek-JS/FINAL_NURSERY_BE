import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment';

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

const importPrimarySowings = async () => {
  try {
    const { default: PlantCms } = await import('./models/plantCms.model.js');
    const { default: PlantSlot } = await import('./models/slots.model.js');
    const { default: Sowing } = await import('./models/sowing.model.js');

    await connectDB();

    // Sowing data from the table (WM = Watermelon, MM = Muskmelon)
    const sowingData = [
      { date: '04-Nov-2025', crop: 'WM', variety: 'Simbha', qty: 99288 },
      { date: '04-Nov-2025', crop: 'WM', variety: 'Prachand', qty: 19530 },
      { date: '04-Nov-2025', crop: 'WM', variety: 'Impact', qty: 18270 },
      { date: '04-Nov-2025', crop: 'WM', variety: 'Candy', qty: 31752 },
      { date: '05-Nov-2025', crop: 'WM', variety: 'Force-9', qty: 25578 },
      { date: '05-Nov-2025', crop: 'WM', variety: 'Maxx', qty: 14616 },
      { date: '05-Nov-2025', crop: 'WM', variety: 'Bahu plus', qty: 13860 },
      { date: '05-Nov-2025', crop: 'WM', variety: 'Candy', qty: 100528 },
      { date: '07-Nov-2025', crop: 'WM', variety: 'Candy', qty: 26334 },
      { date: '07-Nov-2025', crop: 'WM', variety: 'Bahu', qty: 19152 },
      { date: '07-Nov-2025', crop: 'WM', variety: 'Impact', qty: 43470 },
      { date: '07-Nov-2025', crop: 'WM', variety: 'Force-9', qty: 10080 },
      { date: '10-Nov-2025', crop: 'WM', variety: 'Bahu', qty: 38052 },
      { date: '10-Nov-2025', crop: 'WM', variety: 'Redking', qty: 32634 },
      { date: '10-Nov-2025', crop: 'WM', variety: 'Simbha', qty: 70182 },
      { date: '11-Nov-2025', crop: 'MM', variety: 'Layalpur', qty: 49140 },
      { date: '12-Nov-2025', crop: 'MM', variety: 'Layalpur', qty: 21168 },
      { date: '13-Nov-2025', crop: 'WM', variety: 'Runner', qty: 9702 },
      { date: '13-Nov-2025', crop: 'WM', variety: 'Simbha', qty: 104076 },
      { date: '13-Nov-2025', crop: 'WM', variety: 'Candy', qty: 33390 },
      { date: '13-Nov-2025', crop: 'WM', variety: 'Bahu', qty: 38052 },
      { date: '14-Nov-2025', crop: 'WM', variety: 'Runner', qty: 83664 },
      { date: '15-Nov-2025', crop: 'WM', variety: 'Runner', qty: 3654 },
      { date: '15-Nov-2025', crop: 'WM', variety: 'Simbha', qty: 133686 },
      { date: '15-Nov-2025', crop: 'WM', variety: 'Bahu plus', qty: 25200 },
    ];

    // Map crop codes to plant names
    const cropMap = {
      'WM': 'Watermelon',
      'MM': 'Muskmelon'
    };

    // Map variety names that might differ
    const varietyNameMap = {
      'Runner': 'Layalpur', // For Watermelon, Runner is actually Layalpur
    };

    console.log('\n🌱 Starting PRIMARY Sowing Import...\n');
    console.log(`📊 Total sowings to import: ${sowingData.length}\n`);

    const results = {
      success: [],
      failed: [],
      summary: {
        total: 0,
        imported: 0,
        failed: 0,
        plantsUpdated: {}
      }
    };

    // Process each sowing entry
    for (let i = 0; i < sowingData.length; i++) {
      const entry = sowingData[i];
      try {
        const plantName = cropMap[entry.crop];
        if (!plantName) {
          throw new Error(`Unknown crop code: ${entry.crop}`);
        }

        // Parse date (assuming 2025)
        const sowingDate = moment(entry.date, 'DD-MMM-YYYY').format('DD-MM-YYYY');
        
        // Map variety name if needed
        let varietyName = entry.variety;
        if (varietyNameMap[entry.variety] && entry.crop === 'WM') {
          varietyName = varietyNameMap[entry.variety];
          console.log(`   ℹ️  Mapping "${entry.variety}" to "${varietyName}"`);
        }
        
        console.log(`\n[${i + 1}/${sowingData.length}] Processing: ${entry.date} - ${plantName} ${varietyName} (${entry.qty.toLocaleString()})`);

        // Find plant
        const plant = await PlantCms.findOne({ name: plantName });
        if (!plant) {
          throw new Error(`Plant "${plantName}" not found in CMS`);
        }

        // Find subtype (variety) with better matching
        const varietyMappings = {
          'Bahu plus': ['Bahu Plus', 'Bahubali Plus', 'Bahuplus', 'Bahu+', 'Bahubali'],
          'Bahu': ['Bahu', 'Bahubali'],
          'Force-9': ['Force 9', 'Force9', 'Force-9'],
          'Redking': ['Red King', 'Redking', 'Red King'],
          'Runner': ['Layalpur', 'Runner', 'Runner variety'], // Map Runner to Layalpur for Watermelon
        };

        let targetSubtype = null;

        // First try exact match with mapped name
        targetSubtype = plant.subtypes.find(st => 
          st.name.toLowerCase() === varietyName.toLowerCase()
        );

        // Try mapped variations
        if (!targetSubtype && varietyMappings[varietyName]) {
          const variants = varietyMappings[varietyName];
          targetSubtype = plant.subtypes.find(st => 
            variants.some(v => st.name.toLowerCase() === v.toLowerCase() || 
                              st.name.toLowerCase().includes(v.toLowerCase()) ||
                              v.toLowerCase().includes(st.name.toLowerCase()))
          );
        }

        // Try partial match as last resort
        if (!targetSubtype) {
          targetSubtype = plant.subtypes.find(st => 
            st.name.toLowerCase().includes(varietyName.toLowerCase()) ||
            varietyName.toLowerCase().includes(st.name.toLowerCase())
          );
        }

        if (!targetSubtype) {
          throw new Error(`Subtype "${varietyName}" (original: "${entry.variety}") not found for plant "${plantName}". Available: ${plant.subtypes.map(s => s.name).join(', ')}`);
        }

        // Get plant ready days from subtype or slot
        let plantReadyDays = Number(targetSubtype.plantReadyDays) || 0;

        // Find slot for this date and plant/subtype
        const year = moment(sowingDate, 'DD-MM-YYYY').year();
        const slotDocs = await PlantSlot.find({ 
          plantId: plant._id,
          year: year 
        });

        let matchedSlot = null;
        let slotDoc = null;

        // Convert sowing date to Date object for comparison
        const sowingDateObj = moment(sowingDate, 'DD-MM-YYYY').toDate();
        sowingDateObj.setHours(0, 0, 0, 0);

        // Find slot that contains this sowing date
        for (const doc of slotDocs) {
          for (const subtypeSlot of doc.subtypeSlots || []) {
            if (subtypeSlot.subtypeId.toString() === targetSubtype._id.toString()) {
              for (const slot of subtypeSlot.slots || []) {
                const slotStart = moment(slot.startDay, 'DD-MM-YYYY').toDate();
                const slotEnd = moment(slot.endDay, 'DD-MM-YYYY').toDate();
                slotStart.setHours(0, 0, 0, 0);
                slotEnd.setHours(23, 59, 59, 999);

                if (sowingDateObj >= slotStart && sowingDateObj <= slotEnd) {
                  matchedSlot = slot;
                  slotDoc = doc;
                  break;
                }
              }
              if (matchedSlot) break;
            }
            if (matchedSlot) break;
          }
          if (matchedSlot) break;
        }

        if (!matchedSlot) {
          // Try to find closest slot (within ±7 days)
          let closestSlot = null;
          let closestSlotDoc = null;
          let minDaysDiff = Infinity;

          for (const doc of slotDocs) {
            for (const subtypeSlot of doc.subtypeSlots || []) {
              if (subtypeSlot.subtypeId.toString() === targetSubtype._id.toString()) {
                for (const slot of subtypeSlot.slots || []) {
                  const slotStart = moment(slot.startDay, 'DD-MM-YYYY');
                  const slotEnd = moment(slot.endDay, 'DD-MM-YYYY');
                  const sowingMoment = moment(sowingDate, 'DD-MM-YYYY');
                  
                  const daysToStart = Math.abs(sowingMoment.diff(slotStart, 'days'));
                  const daysToEnd = Math.abs(sowingMoment.diff(slotEnd, 'days'));
                  const minDiff = Math.min(daysToStart, daysToEnd);
                  
                  if (minDiff < minDaysDiff && minDiff <= 7) {
                    minDaysDiff = minDiff;
                    closestSlot = slot;
                    closestSlotDoc = doc;
                  }
                }
              }
            }
          }

          if (closestSlot) {
            matchedSlot = closestSlot;
            slotDoc = closestSlotDoc;
            console.log(`   ⚠️  Using closest slot (${minDaysDiff} days difference)`);
          }
        }

        if (!matchedSlot) {
          throw new Error(`No slot found for ${sowingDate} - ${plantName} ${entry.variety}`);
        }

        // Get plant ready days from slot if available, otherwise from subtype
        if (matchedSlot.plantReadyDays && matchedSlot.plantReadyDays > 0) {
          plantReadyDays = Number(matchedSlot.plantReadyDays);
        }

        // Calculate expected ready date
        const expectedReadyDate = moment(sowingDate, 'DD-MM-YYYY')
          .add(plantReadyDays, 'days')
          .format('DD-MM-YYYY');

        if (plantReadyDays <= 0) {
          throw new Error(`Plant Ready Days not configured for ${plantName} ${entry.variety}. Please set plantReadyDays in subtype or slot.`);
        }

        // Check if sowing already exists for this date/plant/subtype/slot
        const existingSowing = await Sowing.findOne({
          plantId: plant._id,
          subtypeId: targetSubtype._id,
          slotId: matchedSlot._id,
          sowingDate: sowingDate,
          sowingLocation: 'PRIMARY'
        });

        if (existingSowing) {
          // Update existing sowing
          existingSowing.totalQuantityRequired = entry.qty;
          existingSowing.primarySowed = entry.qty;
          existingSowing.totalSowed = entry.qty;
          existingSowing.plantReadyDays = plantReadyDays;
          existingSowing.expectedReadyDate = expectedReadyDate;
          
          // Add to history
          existingSowing.sowingHistory.push({
            date: sowingDate,
            location: 'PRIMARY',
            quantity: entry.qty,
            notes: `Updated from import script`,
            timestamp: new Date()
          });

          await existingSowing.save();
          console.log(`   ✅ Updated existing sowing record`);

          // Update slot
          matchedSlot.primarySowed = (matchedSlot.primarySowed || 0) + entry.qty;
          matchedSlot.plantsSowed = matchedSlot.primarySowed;
          matchedSlot.totalPlants = (matchedSlot.totalPlants || 0) + entry.qty;
          await slotDoc.save();

          results.success.push({
            date: sowingDate,
            plant: plantName,
            variety: targetSubtype.name,
            originalVariety: entry.variety,
            qty: entry.qty,
            status: 'updated',
            slotId: matchedSlot._id
          });
        } else {
          // Create new sowing record
          const newSowing = new Sowing({
            plantId: plant._id,
            plantName: plant.name,
            subtypeId: targetSubtype._id,
            subtypeName: targetSubtype.name,
            slotId: matchedSlot._id,
            sowingDate: sowingDate,
            plantReadyDays: plantReadyDays,
            expectedReadyDate: expectedReadyDate,
            totalQuantityRequired: entry.qty,
            primarySowed: entry.qty,
            officeSowed: 0,
            totalSowed: entry.qty,
            remainingToSow: 0,
            sowingLocation: 'PRIMARY',
            status: 'READY',
            sowingHistory: [{
              date: sowingDate,
              location: 'PRIMARY',
              quantity: entry.qty,
              notes: `Imported from primary sowing data`,
              timestamp: new Date()
            }],
            createdBy: null, // System import
            notes: `Primary sowing imported from report`
          });

          await newSowing.save();
          console.log(`   ✅ Created new sowing record`);

          // Update slot
          matchedSlot.primarySowed = (matchedSlot.primarySowed || 0) + entry.qty;
          matchedSlot.plantsSowed = matchedSlot.primarySowed;
          matchedSlot.totalPlants = (matchedSlot.totalPlants || 0) + entry.qty;
          await slotDoc.save();

          results.success.push({
            date: sowingDate,
            plant: plantName,
            variety: targetSubtype.name,
            originalVariety: entry.variety,
            qty: entry.qty,
            status: 'created',
            slotId: matchedSlot._id
          });
        }

        // Track plant-wise totals
        if (!results.summary.plantsUpdated[plantName]) {
          results.summary.plantsUpdated[plantName] = {};
        }
        const varietyKey = targetSubtype.name;
        if (!results.summary.plantsUpdated[plantName][varietyKey]) {
          results.summary.plantsUpdated[plantName][varietyKey] = {
            count: 0,
            totalQty: 0
          };
        }
        results.summary.plantsUpdated[plantName][varietyKey].count++;
        results.summary.plantsUpdated[plantName][varietyKey].totalQty += entry.qty;

        results.summary.imported++;

      } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        results.failed.push({
          ...entry,
          error: error.message
        });
        results.summary.failed++;
      }

      results.summary.total++;
    }

    // Generate Report
    console.log('\n' + '='.repeat(80));
    console.log('📊 PRIMARY SOWING IMPORT REPORT');
    console.log('='.repeat(80));
    console.log(`\n✅ Successfully imported: ${results.summary.imported}`);
    console.log(`❌ Failed: ${results.summary.failed}`);
    console.log(`📦 Total processed: ${results.summary.total}`);

    console.log('\n📋 Plant-wise Summary:');
    console.log('-'.repeat(80));
    for (const [plant, varieties] of Object.entries(results.summary.plantsUpdated)) {
      console.log(`\n🌱 ${plant}:`);
      for (const [variety, stats] of Object.entries(varieties)) {
        console.log(`   ${variety}: ${stats.count} entries, ${stats.totalQty.toLocaleString()} total plants`);
      }
    }

    if (results.failed.length > 0) {
      console.log('\n❌ Failed Entries:');
      console.log('-'.repeat(80));
      results.failed.forEach((entry, index) => {
        console.log(`${index + 1}. ${entry.date} - ${entry.crop} ${entry.variety} (${entry.qty}): ${entry.error}`);
      });
    }

    console.log('\n✅ Import completed!\n');

  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed\n');
    process.exit(0);
  }
};

importPrimarySowings();

