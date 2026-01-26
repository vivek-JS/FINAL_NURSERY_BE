import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import PlantCms from './models/plantCms.model.js';
import PlantSlot from './models/slots.model.js';
import { generateSlotsForYear } from './controllers/slots.controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const SLOT_YEARS = [2025, 2026];

// Slot sizes by crop
const CROP_SLOT_SIZES = {
  'Banana': 7,
  'Papaya': 7,
  'Watermelon': 1,
  'Muskmelon': 1, // Assuming same as Watermelon
};

// Default slot configuration
const DEFAULT_SLOT_CONFIG = {
  slotDays: 7,
  slotCapacity: 100000,
  slotStartDate: '01-01-2025',
  slotEndDate: '31-12-2026',
  plantReadyDays: 0,
  buffer: 0,
};

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

const buildSlotTemplates = (year, slotSize, plantReadyDays) => {
  const baseSlots = generateSlotsForYear(year, slotSize);

  return baseSlots.map((slot) => ({
    ...slot,
    totalPlants: 0,
    totalBookedPlants: 0,
    availablePlants: 0,
    buffer: 0,
    effectiveBuffer: 0,
    bufferAdjustedCapacity: 0,
    bufferAmount: 0,
    originalTotalPlants: 0,
    isOverflow: false,
    overflow: false,
    status: true,
    plantReadyDays,
    plantsSowed: 0,
    officeSowed: 0,
    primarySowed: 0,
    sowingDate: null,
    plantReadyDate: null,
    reminderBeforePlantReadyDays: 0,
    orders: [],
    allowedSalesmen: [],
    restrictToSalesmen: false,
    isManual: false,
  }));
};

const ensureSlotsForSubtype = async ({ plantId, subtypeId, slotSize, plantReadyDays }) => {
  for (const year of SLOT_YEARS) {
    const existingYearSlots = await PlantSlot.findOne({
      plantId,
      year,
    });

    const slots = buildSlotTemplates(year, slotSize, plantReadyDays);

    if (!existingYearSlots) {
      const subtypeSlots = [
        {
          subtypeId,
          slots,
        },
      ];

      await PlantSlot.create({
        plantId,
        year,
        subtypeSlots,
      });
      continue;
    }

    const subtypeSlotEntry = existingYearSlots.subtypeSlots.find(
      (entry) => entry.subtypeId.toString() === subtypeId.toString()
    );

    if (!subtypeSlotEntry) {
      existingYearSlots.subtypeSlots.push({
        subtypeId,
        slots,
      });
      await existingYearSlots.save();
    } else if (!subtypeSlotEntry.slots || subtypeSlotEntry.slots.length === 0) {
      subtypeSlotEntry.slots = slots;
      await existingYearSlots.save();
    }
  }
};

const normalizeName = (name) => {
  if (!name) return '';
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/-/g, '');
};

const findSubtypeByName = (plant, subtypeName) => {
  if (!plant || !plant.subtypes || !subtypeName) return null;
  
  const normalizedSubtypeName = normalizeName(subtypeName);
  
  return plant.subtypes.find((st) => {
    const stName = normalizeName(st.name);
    return stName === normalizedSubtypeName;
  });
};

const configureSlots = async () => {
  try {
    await connectDB();

    // Read Excel file to get all crop-variety combinations
    const filePath = path.join(__dirname, 'fetch-excel', 'new_booking.xlsx');
    const fileBuffer = XLSX.readFile(filePath);
    const worksheet = fileBuffer.Sheets['BOOKING LIST'];
    const data = XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: true });

    // Extract unique crop-variety combinations (normalized)
    const cropVarietyMap = new Map();

    data.forEach((row) => {
      const crop = row['Crop'];
      const variety = row['Variety'];

      if (crop && variety) {
        const cropStr = String(crop).trim();
        const varietyStr = String(variety).trim();

        if (cropStr && varietyStr && cropStr !== 'null' && varietyStr !== 'null') {
          // Normalize case: capitalize first letter, rest lowercase
          let normalizedCrop = cropStr.charAt(0).toUpperCase() + cropStr.slice(1).toLowerCase();
          let normalizedVariety = varietyStr.charAt(0).toUpperCase() + varietyStr.slice(1).toLowerCase();
          
          // Special handling for known variations
          if (normalizedVariety.toLowerCase() === 'simbha') {
            normalizedVariety = 'Simbha';
          } else if (normalizedVariety.toLowerCase() === 'maxx') {
            normalizedVariety = 'Maxx';
          }
          
          const key = `${normalizedCrop}::${normalizedVariety}`;
          
          if (!cropVarietyMap.has(key)) {
            cropVarietyMap.set(key, {
              crop: normalizedCrop,
              variety: normalizedVariety,
              originalCrop: cropStr,
              originalVariety: varietyStr,
            });
          }
        }
      }
    });

    console.log(`\n📋 Found ${cropVarietyMap.size} unique crop-variety combinations\n`);

    // Process each combination
    let successCount = 0;
    let errorCount = 0;

    for (const [key, { crop, variety, originalCrop, originalVariety }] of cropVarietyMap.entries()) {
      try {
        console.log(`\n🌱 Processing: ${crop} - ${variety}`);

        // Find or create plant
        let plant = await PlantCms.findOne({ name: new RegExp(`^${crop}$`, 'i') });
        
        if (!plant) {
          console.log(`   ⚠️  Plant "${crop}" not found, creating...`);
          const slotSize = CROP_SLOT_SIZES[crop] || 7;
          
          plant = new PlantCms({
            name: crop,
            slotSize: slotSize,
            sowingAllowed: false,
            subtypes: [],
          });
          await plant.save();
          console.log(`   ✅ Created plant "${crop}"`);
        }

        // Find or create subtype
        let subtype = findSubtypeByName(plant, variety);
        
        if (!subtype) {
          console.log(`   ⚠️  Variety "${variety}" not found for "${crop}", creating...`);
          
          const slotSize = CROP_SLOT_SIZES[crop] || 7;
          
          const newSubtype = {
            name: variety,
            description: `Auto-created variety: ${variety}`,
            rates: [],
            buffer: 0,
            plantReadyDays: 0,
            slotDays: slotSize,
            slotCapacity: DEFAULT_SLOT_CONFIG.slotCapacity,
            slotStartDate: DEFAULT_SLOT_CONFIG.slotStartDate,
            slotEndDate: DEFAULT_SLOT_CONFIG.slotEndDate,
          };

          plant.subtypes.push(newSubtype);
          await plant.save();
          
          // Refresh to get the new subtype ID
          plant = await PlantCms.findById(plant._id);
          subtype = findSubtypeByName(plant, variety);
          
          console.log(`   ✅ Created variety "${variety}"`);
        }

        // Configure slots
        const slotSize = CROP_SLOT_SIZES[crop] || 7;
        const plantReadyDays = subtype.plantReadyDays || 0;

        console.log(`   ⚙️  Configuring slots (size: ${slotSize} days) for years ${SLOT_YEARS.join(', ')}...`);
        
        await ensureSlotsForSubtype({
          plantId: plant._id,
          subtypeId: subtype._id,
          slotSize: slotSize,
          plantReadyDays: plantReadyDays,
        });

        console.log(`   ✅ Slots configured for ${crop} - ${variety}`);
        successCount++;

      } catch (error) {
        console.error(`   ❌ Error processing ${crop} - ${variety}:`, error.message);
        errorCount++;
      }
    }

    console.log(`\n\n${'='.repeat(60)}`);
    console.log(`📊 SUMMARY`);
    console.log(`${'='.repeat(60)}`);
    console.log(`✅ Successfully configured: ${successCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`📋 Total combinations: ${cropVarietyMap.size}`);
    console.log(`${'='.repeat(60)}\n`);

    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB');

  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
};

configureSlots();

