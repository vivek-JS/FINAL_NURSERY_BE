import mongoose from 'mongoose';
import XLSX from 'xlsx';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import PlantCms from './models/plantcms.model.js';
import PlantSlot from './models/slots.model.js';
import moment from 'moment';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// MongoDB connection string
const MONGO_URL = 'mongodb+srv://vivekcreact_db_user:Vivek006%40%23@ram.tddrg8s.mongodb.net/?appName=Ram';

// Default configuration for plants
const DEFAULT_PLANT_CONFIG = {
  slotSize: 7,
  plantReadyDays: 0,
  sowingAllowed: false,
  slotDays: 7,
  slotCapacity: 100000,
  slotStartDate: '01-01-2025',
  slotEndDate: '31-12-2026'
};

// Known plant configurations
const TARGET_PLANT_CONFIG = {
  Papaya: {
    slotSize: 7,
    plantReadyDays: 40,
    sowingAllowed: true,
    slotDays: 7,
    slotCapacity: 100000,
    slotStartDate: '01-01-2025',
    slotEndDate: '31-12-2026'
  },
  Muskmelon: {
    slotSize: 1,
    plantReadyDays: 13,
    sowingAllowed: true,
    slotDays: 1,
    slotCapacity: 100000,
    slotStartDate: '01-01-2025',
    slotEndDate: '31-12-2026'
  },
  Watermelon: {
    slotSize: 1,
    plantReadyDays: 18,
    sowingAllowed: true,
    slotDays: 1,
    slotCapacity: 100000,
    slotStartDate: '01-01-2025',
    slotEndDate: '31-12-2026'
  },
  Banana: {
    slotSize: 7,
    plantReadyDays: 0,
    sowingAllowed: true,
    slotDays: 7,
    slotCapacity: 100000,
    slotStartDate: '01-01-2025',
    slotEndDate: '31-12-2026'
  }
};

const SLOT_YEARS = [2025, 2026];

const normalizeName = (value) => (value || "").toString().trim();

// Normalize by removing hyphens and spaces for comparison
const normalizeForComparison = (name) => {
  return normalizeName(name).toLowerCase().replace(/-/g, '').replace(/\s+/g, '');
};

// Function to map variety names to correct system names
function mapVarietyName(cropName, varietyName) {
  if (!varietyName) return varietyName;
  
  // Normalize case: capitalize first letter, rest lowercase
  let normalized = String(varietyName).trim();
  
  // Special handling for known case variations
  const lowerVariety = normalized.toLowerCase();
  if (lowerVariety === 'simbha') {
    normalized = 'Simbha';
  } else if (lowerVariety === 'maxx') {
    normalized = 'Maxx';
  } else {
    // Capitalize first letter, rest lowercase
    normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
  }
  
  return normalized;
}

// Extract main crop name from compound names
const extractMainCropName = (cropName) => {
  if (!cropName) return null;
  const normalized = normalizeName(cropName);
  
  // Known crop names that might have suffixes
  const cropPrefixes = ['Papaya', 'Muskmelon', 'Watermelon', 'Banana'];
  for (const prefix of cropPrefixes) {
    if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
      return prefix;
    }
  }
  
  return normalized;
};

// Generate slots for a year
const generateSlotsForYear = (year, slotDays) => {
  const slots = [];
  const startDate = moment(`${year}-01-01`, 'YYYY-MM-DD');
  const endDate = moment(`${year}-12-31`, 'YYYY-MM-DD');
  
  let currentDate = startDate.clone();
  
  while (currentDate.isSameOrBefore(endDate)) {
    const slotStart = currentDate.clone();
    let slotEnd = currentDate.clone().add(slotDays - 1, 'days');
    
    // Don't exceed the end date
    if (slotEnd.isAfter(endDate)) {
      slotEnd = endDate.clone();
    }
    
    // Don't exceed month boundary
    const monthEnd = slotStart.clone().endOf('month');
    if (slotEnd.isAfter(monthEnd)) {
      slotEnd = monthEnd.clone();
    }
    
    slots.push({
      startDay: slotStart.format('DD-MM-YYYY'),
      endDay: slotEnd.format('DD-MM-YYYY'),
      month: slotStart.format('MMMM'),
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
      plantReadyDays: 0,
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
      slotTrail: []
    });
    
    // Move to next period
    currentDate = slotEnd.clone().add(1, 'days');
  }
  
  return slots;
};

// Ensure slots for a subtype
const ensureSlotsForSubtype = async ({
  plantId,
  subtypeId,
  slotDays,
  plantReadyDays,
}) => {
  for (const year of SLOT_YEARS) {
    const existingYearSlots = await PlantSlot.findOne({
      plantId,
      year,
    });

    const slots = generateSlotsForYear(year, slotDays);

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
      console.log(`  ✅ Created slots for year ${year}`);
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
      console.log(`  ✅ Added slots for year ${year}`);
    } else if (!subtypeSlotEntry.slots || subtypeSlotEntry.slots.length === 0) {
      subtypeSlotEntry.slots = slots;
      await existingYearSlots.save();
      console.log(`  ✅ Updated slots for year ${year}`);
    } else {
      console.log(`  ℹ️  Slots already exist for year ${year}`);
    }
  }
};

// Ensure plant and subtype exist
const ensurePlantAndSubtype = async ({
  plantName,
  subtypeName,
  plantMap,
}) => {
  const config = TARGET_PLANT_CONFIG[plantName] || DEFAULT_PLANT_CONFIG;
  const effectiveConfig = config || DEFAULT_PLANT_CONFIG;

  const normalizedSubtypeName = normalizeName(subtypeName);

  if (!normalizedSubtypeName) {
    const normalizedPlantName = normalizeName(plantName);
    return plantMap.get(normalizedPlantName) || null;
  }

  // Use normalized name for map lookup to ensure consistency
  const normalizedPlantName = normalizeName(plantName);
  let plantEntry = plantMap.get(normalizedPlantName);
  
  // If not in map, try to find in database (might have been created by another process)
  if (!plantEntry) {
    const dbPlant = await PlantCms.findOne({ name: plantName }).lean();
    if (dbPlant) {
      plantEntry = dbPlant;
      plantMap.set(normalizedPlantName, dbPlant);
    }
  }
  
  let plantDoc = null;
  let isDirty = false;

  if (!plantEntry) {
    // Create new plant with subtype
    plantDoc = new PlantCms({
      name: plantName,
      slotSize: effectiveConfig.slotSize,
      sowingAllowed: effectiveConfig.sowingAllowed,
      subtypes: [
        {
          name: normalizedSubtypeName,
          plantReadyDays: effectiveConfig.plantReadyDays,
          slotDays: effectiveConfig.slotDays,
          slotCapacity: effectiveConfig.slotCapacity,
          slotStartDate: effectiveConfig.slotStartDate,
          slotEndDate: effectiveConfig.slotEndDate,
        },
      ],
    });

    await plantDoc.save();
    isDirty = true;
    console.log(`  ✅ Created new plant: ${plantName} with subtype: ${normalizedSubtypeName}`);
  } else {
    plantDoc = await PlantCms.findById(plantEntry._id);

    if (!plantDoc) {
      plantMap.delete(normalizedPlantName);
      return null;
    }

    // Update plant config if needed (only for TARGET_PLANT_CONFIG plants)
    if (TARGET_PLANT_CONFIG[plantName]) {
      if (plantDoc.slotSize !== config.slotSize) {
        plantDoc.slotSize = config.slotSize;
        isDirty = true;
      }

      if (!plantDoc.sowingAllowed && config.sowingAllowed) {
        plantDoc.sowingAllowed = true;
        isDirty = true;
      }
    }

    const existingSubtype = plantDoc.subtypes.find(
      (subtype) => normalizeForComparison(subtype.name) === normalizeForComparison(normalizedSubtypeName)
    );

    if (!existingSubtype) {
      // Add new subtype with configuration
      plantDoc.subtypes.push({
        name: normalizedSubtypeName,
        plantReadyDays: effectiveConfig.plantReadyDays,
        slotDays: effectiveConfig.slotDays,
        slotCapacity: effectiveConfig.slotCapacity,
        slotStartDate: effectiveConfig.slotStartDate,
        slotEndDate: effectiveConfig.slotEndDate,
      });
      isDirty = true;
      console.log(`  ✅ Added subtype: ${normalizedSubtypeName} to plant: ${plantName}`);
    } else {
      // Update subtype config if missing
      if (!existingSubtype.slotDays) {
        existingSubtype.slotDays = effectiveConfig.slotDays;
        isDirty = true;
      }
      if (!existingSubtype.slotCapacity) {
        existingSubtype.slotCapacity = effectiveConfig.slotCapacity;
        isDirty = true;
      }
      if (!existingSubtype.slotStartDate) {
        existingSubtype.slotStartDate = effectiveConfig.slotStartDate;
        isDirty = true;
      }
      if (!existingSubtype.slotEndDate) {
        existingSubtype.slotEndDate = effectiveConfig.slotEndDate;
        isDirty = true;
      }
      if (TARGET_PLANT_CONFIG[plantName] && existingSubtype.plantReadyDays !== config.plantReadyDays) {
        existingSubtype.plantReadyDays = config.plantReadyDays;
        isDirty = true;
      }
    }

    if (isDirty) {
      await plantDoc.save();
    }
  }

  const subtype = plantDoc.subtypes.find(
    (subtype) => normalizeForComparison(subtype.name) === normalizeForComparison(normalizedSubtypeName)
  );

  if (subtype) {
    // Use subtype's configuration or fallback to defaults
    const slotDays = subtype.slotDays || effectiveConfig.slotSize || 7;
    const plantReadyDays = subtype.plantReadyDays || effectiveConfig.plantReadyDays || 0;
    
    await ensureSlotsForSubtype({
      plantId: plantDoc._id,
      subtypeId: subtype._id,
      slotSize: slotDays,
      plantReadyDays: plantReadyDays,
    });
  }

  const refreshedPlant = await PlantCms.findById(plantDoc._id).lean();
  // Update map with normalized name as key
  plantMap.set(normalizedPlantName, refreshedPlant);

  return refreshedPlant;
};

// Main function
const createAllPlantsSubtypesSlots = async () => {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(MONGO_URL);
    console.log('✅ Connected to MongoDB\n');

    // Find Excel file
    const excelFiles = [
      join(__dirname, 'fetch-excel', 'BOOKING DETAILS 2025-26 Final (1).xlsx'),
      join(__dirname, 'fetch-excel', 'new_booking.xlsx'),
      join(__dirname, 'BOOKING DETAILS 2025-26 (8).xlsx'),
      join(__dirname, 'fetch-excel', 'BOOKING DETAILS 2025-26 Final (1).xlsx'),
    ];

    let workbook = null;
    let filePath = null;

    for (const file of excelFiles) {
      try {
        const fs = await import('fs');
        if (fs.existsSync(file)) {
          workbook = XLSX.readFile(file);
          filePath = file;
          console.log(`📄 Found Excel file: ${file}\n`);
          break;
        }
      } catch (error) {
        // Continue to next file
      }
    }

    if (!workbook) {
      throw new Error('Excel file not found. Please ensure the file exists in fetch-excel folder.');
    }

    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(worksheet, {
      raw: true,
      dateNF: 'DD-MM-YYYY',
      defval: '',
      blankrows: false,
    });

    console.log(`📊 Found ${data.length} rows in Excel file\n`);

    // Extract unique plant/subtype combinations
    const plantSubtypeMap = new Map();
    
    for (const row of data) {
      const cropName = row['Crop'] || row['Crop\r\n'] || '';
      const varietyName = row['Variety'] || row['Variety\r\n'] || '';
      
      if (!cropName || !varietyName) continue;
      
      const normalizedCrop = extractMainCropName(cropName);
      const mappedVarietyName = mapVarietyName(normalizedCrop, varietyName);
      
      if (!normalizedCrop || !mappedVarietyName) continue;
      
      const key = `${normalizedCrop}::${mappedVarietyName}`;
      if (!plantSubtypeMap.has(key)) {
        plantSubtypeMap.set(key, {
          plantName: normalizedCrop,
          subtypeName: mappedVarietyName,
        });
      }
    }

    console.log(`🌱 Found ${plantSubtypeMap.size} unique plant/subtype combinations:\n`);
    Array.from(plantSubtypeMap.values()).forEach(({ plantName, subtypeName }) => {
      console.log(`  - ${plantName} -> ${subtypeName}`);
    });
    console.log();

    // Get all existing plants
    const allPlants = await PlantCms.find({}).lean();
    const plantMap = new Map(allPlants.map(p => [normalizeName(p.name), p]));

    // Create/update all plants and subtypes
    console.log('⚙️  Creating/updating plants and subtypes...\n');
    for (const [key, { plantName, subtypeName }] of plantSubtypeMap) {
      try {
        console.log(`Processing: ${plantName} -> ${subtypeName}`);
        await ensurePlantAndSubtype({
          plantName,
          subtypeName,
          plantMap,
        });
        console.log(`✅ Completed: ${plantName} -> ${subtypeName}\n`);
      } catch (error) {
        console.error(`❌ Error processing ${plantName} -> ${subtypeName}:`, error.message);
        console.log();
      }
    }

    console.log('\n✅ Successfully created/updated all plants, subtypes, and slots!');
    console.log(`\n📊 Summary:`);
    console.log(`   - Total unique combinations: ${plantSubtypeMap.size}`);
    console.log(`   - Years configured: ${SLOT_YEARS.join(', ')}`);

    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
};

createAllPlantsSubtypesSlots();

