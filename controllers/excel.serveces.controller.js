// services/excel.service.js
import mongoose from "mongoose";
import XLSX from "xlsx";
import moment from "moment";
import bcrypt from "bcryptjs";
import Farmer from "../models/farmer.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import User from "../models/user.model.js";
import Order from "../models/order.model.js";
import ErrorfulOrder from "../models/errorfulOrder.model.js";
import { updateSlot } from "./factory.controller.js";
import Tray from "../models/tray.model.js";
import { generateSlotsForYear } from "./slots.controller.js";

// Function to parse Excel date serial number
function parseExcelDate(serialNumber) {
  const epoch = new Date(1899, 11, 30);
  const offsetDays = serialNumber;
  const offsetMilliseconds = offsetDays * 24 * 60 * 60 * 1000;
  const date = new Date(epoch.getTime() + offsetMilliseconds);
  // Excel dates represent dates at midnight in local timezone (IST)
  // When converted to Date object, it's in UTC which can be the previous day
  // Extract the local date parts to get the correct date
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  // Return a new Date object with the local date parts at noon UTC to avoid timezone issues
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

// Function to check if a value is an Excel date serial number
function isExcelDateSerial(value) {
  return typeof value === "number" && value > 1000 && value < 100000;
}

// Function to format date for display (use UTC to avoid timezone shifts)
function formatDate(date) {
  // Use UTC to prevent day shifts due to timezone differences
  return moment.utc(date).format("DD-MM-YYYY");
}

// Function to map variety names to correct system names
function mapVarietyName(cropName, varietyName) {
  // Variety mapping removed - using exact names from Excel
  // const varietyMappings = {
  //   "Papaya": {
  //     "Taiwan": "Red Lady",
  //     "Taiwan Red": "Red Lady",
  //     "Taiwan Red Lady": "Red Lady"
  //   }
  // };

  // Return variety name as-is without mapping
  return varietyName;
}

// Function to parse order ID from various formats
function parseOrderId(bookingNo) {
  // Check if bookingNo is null, undefined, or empty string (but allow 0)
  if (bookingNo === null || bookingNo === undefined || bookingNo === '') {
    throw new Error("Booking number is required");
  }

  const bookingStr = bookingNo.toString().trim();
  const numericValue = parseInt(bookingStr, 10);

  // If booking number is 0, generate a random 5-digit ID
  if (numericValue === 0) {
    console.log(`⚠️  Booking number is 0, generating random 5-digit ID`);
    const randomId = Math.floor(Math.random() * 90000) + 10000; // 5-digit random number (10000-99999)
    return randomId;
  }

  // Handle new format: "2025/2", "2025/10", etc.
  const newFormatMatch = bookingStr.match(/^(\d{4})\/(\d+)$/);
  if (newFormatMatch) {
    const year = newFormatMatch[1];
    const sequence = newFormatMatch[2];
    // Create unique order ID by combining year and sequence
    return parseInt(`${year}${sequence.padStart(3, '0')}`, 10);
  }

  // Handle old format: "24-25/B123", "24-25/B001", "25-26/80204", "25- 26/80204", etc.
  // Support formats with or without "B", with or without spaces
  const cleanedBooking = bookingStr.replace(/\s+/g, ''); // Remove all spaces
  const oldFormatMatch = cleanedBooking.match(/^(\d{2})-(\d{2})\/B?(\d+)$/);
  if (oldFormatMatch) {
    const startYear = oldFormatMatch[1];
    const endYear = oldFormatMatch[2];
    const sequence = oldFormatMatch[3];
    // Create unique order ID by combining years and sequence
    // For long sequences (like 80204), use last 3-4 digits to keep it reasonable
    const sequenceDigits = sequence.length > 4 ? sequence.slice(-4) : sequence;
    return parseInt(`${startYear}${endYear}${sequenceDigits.padStart(4, '0')}`, 10);
  }

  // Handle simple numeric format: "123", "001", etc.
  const numericMatch = bookingStr.match(/^(\d+)$/);
  if (numericMatch) {
    return parseInt(numericMatch[1], 10);
  }

  // If no format matches, create a hash-based ID
  console.log(`⚠️  Unknown booking number format: "${bookingStr}" - creating hash-based ID`);
  let hash = 0;
  for (let i = 0; i < bookingStr.length; i++) {
    const char = bookingStr.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

// Function to handle date conversion
function convertDate(value) {
  if (!value) return null;

  // If value is already a Date object (shouldn't happen with cellDates: false, but handle it)
  if (value instanceof Date) {
    // Use local date methods to get the date as entered in Excel
    const year = value.getFullYear();
    const month = value.getMonth() + 1; // getMonth() returns 0-11
    const day = value.getDate();
    
    // Create UTC moment from the local date parts to preserve the intended date
    const utcDate = moment.utc(`${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`);
    return utcDate.format("DD-MM-YYYY");
  }

  if (isExcelDateSerial(Number(value))) {
    // Parse Excel serial number
    // Excel serial numbers represent dates at midnight in Excel's timezone (IST)
    // When converted to Date object, it's in UTC which can be the previous day
    const serialNumber = Number(value);
    const epoch = new Date(1899, 11, 30);
    const offsetDays = serialNumber;
    const offsetMilliseconds = offsetDays * 24 * 60 * 60 * 1000;
    const date = new Date(epoch.getTime() + offsetMilliseconds);
    
    // Excel dates are stored at midnight IST, which is 5:30 AM UTC the same day
    // But the Date object might show as previous day in UTC
    // Add IST offset (5.5 hours) to get the correct IST date, then extract UTC parts
    const istOffsetMs = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
    const istDate = new Date(date.getTime() + istOffsetMs);
    
    // Extract UTC date parts from the IST-adjusted date
    const year = istDate.getUTCFullYear();
    const month = istDate.getUTCMonth() + 1;
    const day = istDate.getUTCDate();
    
    // Create UTC moment from the date parts to preserve the intended date
    const utcDate = moment.utc(`${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`);
    return utcDate.format("DD-MM-YYYY");
  }

  const valueStr = value.toString().trim();

  // Handle MM/DD/YY format (like "11/10/25" for Nov 10, 2025)
  const mmddyyMatch = valueStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (mmddyyMatch) {
    const month = parseInt(mmddyyMatch[1], 10);
    const day = parseInt(mmddyyMatch[2], 10);
    const year = parseInt(mmddyyMatch[3], 10);
    
    // Convert 2-digit year to 4-digit year (00-30 = 2000-2030, 31-99 = 1931-1999)
    const fullYear = year > 30 ? 1900 + year : 2000 + year;
    
    // Validate the date
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && fullYear >= 2000 && fullYear <= 2030) {
      // Use UTC to prevent timezone shifts
      const date = moment.utc(`${fullYear}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`);
      if (date.isValid()) {
        return date.format("DD-MM-YYYY");
      }
    }
  }

  // Handle MM/DD/YYYY format specifically (like "9/21/2024" or "12/3/2025")
  const mmddyyyyMatch = valueStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mmddyyyyMatch) {
    const month = parseInt(mmddyyyyMatch[1], 10);
    const day = parseInt(mmddyyyyMatch[2], 10);
    const year = parseInt(mmddyyyyMatch[3], 10);
    
    // Validate the date
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2030) {
      // Use UTC to prevent timezone shifts
      const date = moment.utc(`${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`);
      if (date.isValid()) {
        return date.format("DD-MM-YYYY");
      }
    }
  }

  // Handle DD-MM-YYYY format
  const ddmmyyyyMatch = valueStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (ddmmyyyyMatch) {
    const day = parseInt(ddmmyyyyMatch[1], 10);
    const month = parseInt(ddmmyyyyMatch[2], 10);
    const year = parseInt(ddmmyyyyMatch[3], 10);
    
    // Validate the date
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2030) {
      // Use UTC to prevent timezone shifts
      const date = moment.utc(`${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`);
      if (date.isValid()) {
        return date.format("DD-MM-YYYY");
      }
    }
  }

  // Handle YYYY-MM-DD format
  const yyyymmddMatch = valueStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (yyyymmddMatch) {
    const year = parseInt(yyyymmddMatch[1], 10);
    const month = parseInt(yyyymmddMatch[2], 10);
    const day = parseInt(yyyymmddMatch[3], 10);
    
    // Validate the date
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2030) {
      // Use UTC to prevent timezone shifts
      const date = moment.utc(`${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`);
      if (date.isValid()) {
        return date.format("DD-MM-YYYY");
      }
    }
  }

  // Fallback to moment.js parsing for other formats (use UTC to prevent timezone shifts)
  const date = moment.utc(value, ["DD-MM-YYYY", "MM/DD/YYYY", "YYYY-MM-DD"]);
  return date.isValid() ? date.format("DD-MM-YYYY") : null;
}

// Function to clean and validate mobile numbers
export const cleanAndValidateMobileNumber = (mobileData) => {
  let mobileNumbers = mobileData;

  // Handle case where mobileNumbers is already an array
  if (Array.isArray(mobileNumbers)) {
    mobileNumbers = mobileNumbers.join(" ");
  }

  // Convert to string and clean
  mobileNumbers = (mobileNumbers || "")
    .toString()
    .split(/[,\/\s]+/)
    .map((num) => num.replace(/\s+/g, "").replace(/^-+/, "").replace(/-+$/, "")) // Remove leading and trailing dashes
    .filter((num) => num && num.length > 0 && num !== "''" && num !== '""'); // Remove empty strings and quoted empty strings

  if (mobileNumbers.length === 0) {
    return {
      primaryNumber: null,
      alternateNumber: null,
      isInvalid: true,
      originalValue: mobileData,
    };
  }

  let primaryNumber = mobileNumbers[0];
  let alternateNumber = mobileNumbers.length > 1 ? mobileNumbers[1] : null;

  // Try to combine partial numbers (like "88308 33233")
  if (
    primaryNumber &&
    primaryNumber.length < 10 &&
    alternateNumber &&
    alternateNumber.length < 10
  ) {
    const combined = primaryNumber + alternateNumber;
    if (combined.length === 10 && /^\d{10}$/.test(combined)) {
      primaryNumber = combined;
      alternateNumber = null;
    }
  }

  // Mark 9-digit numbers as invalid (don't auto-fix them)
  const isPrimaryNineDigit = primaryNumber && primaryNumber.length === 9;
  const isAlternateNineDigit = alternateNumber && alternateNumber.length === 9;

  // Validate final numbers (mark 9-digit numbers as invalid)
  const isPrimaryValid = primaryNumber && /^\d{10}$/.test(primaryNumber) && !isPrimaryNineDigit;
  const isAlternateValid = alternateNumber && /^\d{10}$/.test(alternateNumber) && !isAlternateNineDigit;

  return {
    primaryNumber: isPrimaryValid ? parseInt(primaryNumber, 10) : null,
    alternateNumber: isAlternateValid ? parseInt(alternateNumber, 10) : null,
    isInvalid: !isPrimaryValid || isPrimaryNineDigit,
    originalValue: mobileData,
  };
};

// Helper function to get slot information with overflow status
export const getSlotInfo = async (slotId) => {
  const { getSlotInfoWithBookedPlants } = await import('../utility/slotBookedPlantsCalculator.js');
  return await getSlotInfoWithBookedPlants(slotId);
};

// Helper function to automatically create tray (cavity)
const createTray = async (cavityValue) => {
  try {
    // Parse cavity value to number
    const cavityNumber = parseInt(cavityValue, 10);
    
    if (isNaN(cavityNumber) || cavityNumber <= 0) {
      throw new Error(`Invalid cavity value: ${cavityValue}`);
    }

    // Check if tray already exists by cavity number
    const existingTray = await Tray.findOne({ cavity: cavityNumber });
    if (existingTray) {
      return existingTray;
    }

    // Check if tray exists by name
    const existingTrayByName = await Tray.findOne({ name: cavityValue.toString() });
    if (existingTrayByName) {
      return existingTrayByName;
    }

    // Create new tray with default values
    // Default numberPerCrate: 1 (can be updated later)
    const newTray = new Tray({
      name: `Media ${cavityNumber}`,
      cavity: cavityNumber,
      numberPerCrate: 1, // Default value, can be updated later
      isActive: true,
    });

    await newTray.save();
    console.log(`✅ Auto-created tray: Media ${cavityNumber} (${cavityNumber} cavity)`);
    
    return newTray;
  } catch (error) {
    console.error(`❌ Error creating tray for cavity ${cavityValue}:`, error);
    throw new Error(`Failed to create tray for cavity "${cavityValue}": ${error.message}`);
  }
};

// Helper function to automatically create reference user (generic user)
const createReferenceUser = async (name, phoneNumber = null) => {
  try {
    // Check if user already exists by name
    const existingUser = await User.findOne({ name: name });
    if (existingUser) {
      return existingUser;
    }

    // Handle phone number assignment
    let finalPhoneNumber = phoneNumber;
    if (!finalPhoneNumber) {
      // Generate a unique phone number if not provided
      let counter = 1;
      do {
        finalPhoneNumber = 9999990000 + counter;
        counter++;
        if (counter > 9999) {
          throw new Error("Unable to generate unique phone number");
        }
      } while (await User.findOne({ phoneNumber: finalPhoneNumber }));
    } else {
      // Check if the provided phone number is already in use
      const existingUserWithPhone = await User.findOne({ phoneNumber: finalPhoneNumber });
      if (existingUserWithPhone) {
        // If phone number is already in use, generate a unique one
        console.log(`⚠️ Phone number ${finalPhoneNumber} already in use, generating unique number for ${name}`);
        let counter = 1;
        do {
          finalPhoneNumber = 9999990000 + counter;
          counter++;
          if (counter > 9999) {
            throw new Error("Unable to generate unique phone number");
          }
        } while (await User.findOne({ phoneNumber: finalPhoneNumber }));
      }
    }

    // Generate default password
    const DEFAULT_PASSWORD = "1234";
    const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 12);

    // Create new user (default role as SALES, can be updated later)
    const newUser = new User({
      name: name,
      phoneNumber: finalPhoneNumber,
      password: hashedPassword,
      role: "SALES",
      jobTitle: "SALES",
      isPasswordSet: false,
      isDisabled: false,
      isOnboarded: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await newUser.save();
    console.log(`✅ Auto-created reference user: ${name} (${finalPhoneNumber})`);
    
    return newUser;
  } catch (error) {
    console.error(`❌ Error creating reference user ${name}:`, error);
    throw new Error(`Failed to create reference user "${name}": ${error.message}`);
  }
};

// Helper function to automatically create sales person
const createSalesPerson = async (name, phoneNumber = null) => {
  try {
    // Check if sales person already exists by name
    const existingUser = await User.findOne({ name: name });
    if (existingUser) {
      return existingUser;
    }

    // Handle phone number assignment
    let finalPhoneNumber = phoneNumber;
    if (!finalPhoneNumber) {
      // Generate a unique phone number if not provided
      let counter = 1;
      do {
        finalPhoneNumber = 9999990000 + counter;
        counter++;
        if (counter > 9999) {
          throw new Error("Unable to generate unique phone number");
        }
      } while (await User.findOne({ phoneNumber: finalPhoneNumber }));
    } else {
      // Check if the provided phone number is already in use
      const existingUserWithPhone = await User.findOne({ phoneNumber: finalPhoneNumber });
      if (existingUserWithPhone) {
        // If phone number is already in use, generate a unique one
        console.log(`⚠️ Phone number ${finalPhoneNumber} already in use, generating unique number for ${name}`);
        let counter = 1;
        do {
          finalPhoneNumber = 9999990000 + counter;
          counter++;
          if (counter > 9999) {
            throw new Error("Unable to generate unique phone number");
          }
        } while (await User.findOne({ phoneNumber: finalPhoneNumber }));
      }
    }

    // Generate default password
    const DEFAULT_PASSWORD = "1234";
    const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 12);

    // Create new sales person
    const newSalesPerson = new User({
      name: name,
      phoneNumber: finalPhoneNumber,
      password: hashedPassword,
      role: "SALES",
      jobTitle: "SALES",
      isPasswordSet: false, // They need to reset password on first login
      isDisabled: false,
      isOnboarded: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await newSalesPerson.save();
    console.log(`✅ Auto-created sales person: ${name} (${finalPhoneNumber})`);
    
    return newSalesPerson;
  } catch (error) {
    console.error(`❌ Error creating sales person ${name}:`, error);
    throw new Error(`Failed to create sales person "${name}": ${error.message}`);
  }
};

const TARGET_PLANT_CONFIG = {
  Papaya: {
    slotSize: 7,
    plantReadyDays: 40,
    sowingAllowed: true,
  },
  Muskmelon: {
    slotSize: 1,
    plantReadyDays: 13,
    sowingAllowed: true,
  },
  Watermelon: {
    slotSize: 1,
    plantReadyDays: 18,
    sowingAllowed: true,
  },
};

const SLOT_YEARS = [2025, 2026];

const normalizeName = (value) => (value || "").toString().trim();

// Extract main crop name from compound names like "Watermelon Babubali" -> "Watermelon"
const extractMainCropName = (cropName) => {
  if (!cropName) return null;
  const normalized = normalizeName(cropName);
  
  // Known crop names that might have suffixes
  const mainCrops = ['Papaya', 'Muskmelon', 'Watermelon'];
  
  for (const mainCrop of mainCrops) {
    if (normalized.toLowerCase().startsWith(mainCrop.toLowerCase())) {
      return mainCrop;
    }
  }
  
  return normalized; // Return as-is if no match
};

const findSubtypeByName = (plant, subtypeName) => {
  if (!plant || !plant.subtypes || !subtypeName) {
    return null;
  }

  const targetName = normalizeName(subtypeName).toLowerCase();
  return plant.subtypes.find(
    (subtype) => normalizeName(subtype.name).toLowerCase() === targetName
  );
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

const ensureSlotsForSubtype = async ({
  plantId,
  subtypeId,
  slotSize,
  plantReadyDays,
}) => {
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

const ensurePlantAndSubtype = async ({
  plantName,
  subtypeName,
  plantMap,
}) => {
  const config = TARGET_PLANT_CONFIG[plantName];
  if (!config) {
    return plantMap.get(plantName) || null;
  }

  const normalizedSubtypeName = normalizeName(subtypeName);

  if (!normalizedSubtypeName) {
    return plantMap.get(plantName) || null;
  }

  let plantEntry = plantMap.get(plantName);
  let plantDoc = null;
  let isDirty = false;

  if (!plantEntry) {
    plantDoc = new PlantCms({
      name: plantName,
      slotSize: config.slotSize,
      sowingAllowed: config.sowingAllowed,
      subtypes: [
        {
          name: normalizedSubtypeName,
          plantReadyDays: config.plantReadyDays,
        },
      ],
    });

    await plantDoc.save();
    isDirty = true;
  } else {
    plantDoc = await PlantCms.findById(plantEntry._id);

    if (!plantDoc) {
      plantMap.delete(plantName);
      return null;
    }

    if (plantDoc.slotSize !== config.slotSize) {
      plantDoc.slotSize = config.slotSize;
      isDirty = true;
    }

    if (!plantDoc.sowingAllowed && config.sowingAllowed) {
      plantDoc.sowingAllowed = true;
      isDirty = true;
    }

    const existingSubtype = findSubtypeByName(
      plantDoc,
      normalizedSubtypeName
    );

    if (!existingSubtype) {
      plantDoc.subtypes.push({
        name: normalizedSubtypeName,
        plantReadyDays: config.plantReadyDays,
      });
      isDirty = true;
    } else if (
      existingSubtype.plantReadyDays !== config.plantReadyDays
    ) {
      existingSubtype.plantReadyDays = config.plantReadyDays;
      isDirty = true;
    }

    if (isDirty) {
      await plantDoc.save();
    }
  }

  const subtype = findSubtypeByName(plantDoc, normalizedSubtypeName);

  if (subtype) {
    await ensureSlotsForSubtype({
      plantId: plantDoc._id,
      subtypeId: subtype._id,
      slotSize: config.slotSize,
      plantReadyDays: config.plantReadyDays,
    });
  }

  const refreshedPlant = await PlantCms.findById(plantDoc._id).lean();
  plantMap.set(plantName, refreshedPlant);

  return refreshedPlant;
};

export const validateExcelStructure = (buffer) => {
  console.log("🔍 Starting Excel validation...");

  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
    raw: true,
  });

  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(worksheet, {
    raw: true,
    dateNF: "DD-MM-YYYY",
    defval: "", // Default value for empty cells
    blankrows: true, // Include blank rows to process all 65 rows
  });

  console.log("Sample data:", data[0]);
  const availableColumns = Object.keys(data[0] || {});
  console.log("Available columns in first row:", availableColumns);

  // Helper function to normalize column names for comparison
  const normalizeColumnName = (name) => {
    if (!name) return "";
    return name.toString().trim().replace(/\r\n/g, " ").replace(/\n/g, " ").replace(/\s+/g, " ").toLowerCase();
  };

  // Helper function to find column by normalized name
  const findColumn = (targetName, availableCols) => {
    const normalizedTarget = normalizeColumnName(targetName);
    return availableCols.find(col => normalizeColumnName(col) === normalizedTarget);
  };

  // Required columns (core columns needed for import)
  const requiredColumns = [
    "Date", // A
    "Booking NO.", // B
    "Name", // C
    "Mobile No.", // D
    "Address", // E (using Address instead of Village)
    "Taluka", // F
    "District", // G
    "Advance\r\nAmt.", // J
    "Crop", // K
    "Variety", // L
    "Media", // M
    "Plant Qty.", // O
    "Rate", // P
    "Expected\r\nDel.\r\nDate", // Q
    "Order\r\nBy", // W
  ];
  
  // Optional columns (nice to have but not required) - NEVER check these as required
  const optionalColumns = [
    "Ad. Amt. Mode", // Y
    "Bank", // Z
    "CH No.", // [
    "Advance\r\nDate", // \
    "Remark", // _
  ];

  const validationResults = {
    isValid: true,
    errors: [],
    warnings: [],
    rowErrors: [],
  };

  // Check if file is empty
  if (data.length === 0) {
    validationResults.isValid = false;
    validationResults.errors.push("Excel file is empty");
    return validationResults;
  }

  // Check required columns (with flexible matching)
  const firstRow = data[0];
  const missingRequiredColumns = [];
  
  console.log('🔍 Checking required columns...');
  requiredColumns.forEach((requiredCol) => {
    const found = findColumn(requiredCol, availableColumns);
    if (!found) {
      missingRequiredColumns.push(requiredCol);
      console.log(`  ❌ Missing required: "${requiredCol}"`);
    } else {
      console.log(`  ✅ Found required: "${requiredCol}" (as "${found}")`);
    }
  });
  
  if (missingRequiredColumns.length > 0) {
    validationResults.isValid = false;
    validationResults.errors.push(
      `Missing required columns: ${missingRequiredColumns.join(", ")}`
    );
  }
  
  // Check optional columns and add warnings if missing (NEVER add to errors)
  const missingOptionalColumns = [];
  console.log('🔍 Checking optional columns...');
  optionalColumns.forEach((optionalCol) => {
    const found = findColumn(optionalCol, availableColumns);
    if (!found) {
      missingOptionalColumns.push(optionalCol);
      console.log(`  ⚠️  Missing optional: "${optionalCol}" (not blocking)`);
    } else {
      console.log(`  ✅ Found optional: "${optionalCol}" (as "${found}")`);
    }
  });
  
  if (missingOptionalColumns.length > 0) {
    // Only add as warning, never as error - CRITICAL: These should NEVER block import
    validationResults.warnings.push(
      `Optional columns missing (will use defaults): ${missingOptionalColumns.join(", ")}`
    );
    console.log(`ℹ️  Optional columns missing (NOT blocking import): ${missingOptionalColumns.join(", ")}`);
  }
  
  // IMPORTANT: Optional columns should NEVER cause isValid to be false
  // Only required columns should affect isValid
  console.log(`📊 Validation result: isValid=${validationResults.isValid}, required missing=${missingRequiredColumns.length}, optional missing=${missingOptionalColumns.length}`);

  // Validate each row
  data.forEach((row, index) => {
    const rowNumber = index + 2;
    console.log(`📋 Processing row ${rowNumber}...`);
    const rowErrors = [];

    // Validate dates
    const dateFields = ["Date", "Expected\r\nDel.\r\nDate", "Advance\r\nDate"];
    dateFields.forEach((field) => {
      if (row[field]) {
        const convertedDate = convertDate(row[field]);
        if (!convertedDate) {
          rowErrors.push(`Invalid date format in ${field}: ${row[field]}`);
        }
      }
    });

    // Validate booking number
    if (!row["Booking NO."]) {
      rowErrors.push("Booking number is required");
    }

    // Validate mobile number
    const mobileValue = row["Mobile No."];

    // Check for empty, null, undefined, or dummy values
    if (
      !mobileValue ||
      mobileValue === "" ||
      mobileValue === null ||
      mobileValue === undefined ||
      mobileValue === "dummy" ||
      mobileValue === "Dummy" ||
      mobileValue === "DUMMY" ||
      mobileValue === "9999999999" ||
      mobileValue === 9999999999
    ) {
      console.log(
        `⚠️  Row ${rowNumber}: Missing/empty mobile number: "${mobileValue}" - will create entry with invalid phone flag`
      );
      validationResults.warnings.push(`Row ${rowNumber}: Missing mobile number - will be marked as invalid`);
    } else {
      const cleanedNumbers = cleanAndValidateMobileNumber(mobileValue);
      console.log(`Row ${rowNumber}:`, cleanedNumbers);

      if (cleanedNumbers.isInvalid) {
        console.log(
          `⚠️  Row ${rowNumber}: Invalid mobile number: "${cleanedNumbers.originalValue}" - will create entry with invalid phone flag`
        );
        validationResults.warnings.push(`Row ${rowNumber}: Invalid mobile number "${cleanedNumbers.originalValue}" - will be marked as invalid`);
      } else {
        console.log(
          `✅ Row ${rowNumber}: Valid mobile number: ${cleanedNumbers.primaryNumber}`
        );
      }
    }

    // Validate quantities
    if (
      !row["Plant Qty."] ||
      isNaN(row["Plant Qty."]) ||
      Number(row["Plant Qty."]) <= 0
    ) {
      rowErrors.push("Invalid plant quantity");
    }

    // Validate rate
    if (!row["Rate"] || isNaN(row["Rate"]) || Number(row["Rate"]) <= 0) {
      rowErrors.push("Invalid rate");
    }

    // Add row errors if any
    if (rowErrors.length > 0) {
      validationResults.isValid = false;
      validationResults.rowErrors.push({
        row: rowNumber,
        errors: rowErrors,
      });
    }
  });

  return validationResults;
};

// Fast and reliable Excel import with smart caching
export const importOrdersAndFarmers = async (fileBuffer, options = {}) => {
  console.log("🚀 Starting fast Excel import...");
  const startTime = Date.now();
  
  // Generate import batch ID for tracking this import session
  const importBatchId = options.importBatchId || `import-${Date.now()}`;
  const sourceFilename = options.sourceFilename || 'unknown.xlsx';

  const workbook = XLSX.read(fileBuffer, {
    type: "buffer",
    cellDates: true,
    raw: true,
  });

  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(worksheet, {
    raw: true,
    dateNF: "DD-MM-YYYY",
    blankrows: true, // Include blank rows to process all 65 rows
  });

  const results = {
    success: [],
    errors: [],
    autoCreatedSalesPersons: [],
    generatedOrderIds: [], // Track generated IDs for 0 booking numbers
    summary: {
      totalProcessed: 0,
      successfulImports: 0,
      failedImports: 0,
      overflowSlots: 0,
      invalidPhoneNumbers: 0,
    },
  };

  console.log(`📊 Processing ${data.length} rows with smart caching`);

  // Step 1: Pre-process all data and collect unique values
  console.log("🔄 Step 1: Pre-processing data...");
  const processedData = [];
  const uniqueSalesPersons = new Set();
  const uniquePlants = new Set();
  const uniqueTrays = new Set();
  const uniqueOrderIds = new Set();
  const validPhoneNumbers = new Set();

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    
    // Skip completely empty rows (no booking number, no name, no crop)
    if (!row["Booking NO."] && !row["Name"] && !row["Crop"]) {
      console.log(`⏭️  Skipping empty row ${i + 2}`);
      continue;
    }
    
    const orderNumber = parseOrderId(row["Booking NO."]);
    const rawCropName = normalizeName(row["Crop"]);
    const cropName = extractMainCropName(rawCropName); // Extract main crop name
    const mappedVarietyName = mapVarietyName(cropName, row["Variety"]);
    
    // Track generated random IDs for 0 booking numbers
    if (row["Booking NO."] == 0 || row["Booking NO."] === "0") {
      results.generatedOrderIds.push({
        row: i + 2, // Excel row number (1-indexed with header)
        bookingNo: row["Booking NO."],
        generatedOrderId: orderNumber,
        name: row["Name"]
      });
    }
    
    processedData.push({
      ...row,
      orderNumber,
      normalizedCrop: cropName,
      mappedVarietyName,
      date: convertDate(row["Date"]),
      slots: convertDate(row["Expected\r\nDel.\r\nDate"]),
      "Advance Date": row["Advance\r\nDate"] ? convertDate(row["Advance\r\nDate"]) : null,
    });

    uniqueOrderIds.add(orderNumber);
    uniqueSalesPersons.add(row["Refrence"]);
    if (cropName) {
      uniquePlants.add(cropName);
    }
    
    if (row["Media"]) {
      uniqueTrays.add(row["Media"]);
    }

    // Collect valid phone numbers
    const mobileValue = row["Mobile No."];
    if (mobileValue && mobileValue !== "9999999999" && mobileValue !== 9999999999) {
      const cleanedNumbers = cleanAndValidateMobileNumber(mobileValue);
      if (cleanedNumbers.primaryNumber) {
        validPhoneNumbers.add(cleanedNumbers.primaryNumber);
      }
      if (cleanedNumbers.alternateNumber) {
        validPhoneNumbers.add(cleanedNumbers.alternateNumber);
      }
    }
  }

  // Step 2: Bulk fetch all reference data
  console.log("📥 Step 2: Bulk fetching reference data...");
  const [
    existingOrders,
    existingFarmers,
    salesPersons,
    plants,
    trays
  ] = await Promise.all([
    Order.find({ orderId: { $in: Array.from(uniqueOrderIds) } }).lean(),
    Farmer.find({
      $or: [
        { mobileNumber: { $in: Array.from(validPhoneNumbers) } },
        { alternateNumber: { $in: Array.from(validPhoneNumbers) } }
      ]
    }).lean(),
    User.find({ name: { $in: Array.from(uniqueSalesPersons) } }).lean(),
    PlantCms.find({ name: { $in: Array.from(uniquePlants) } }).lean(),
    Tray.find({ cavity: { $in: Array.from(uniqueTrays).map(t => 
      typeof t === "string" && t.trim().toLowerCase() === "elli" ? 10 : parseInt(t, 10)
    )} }).lean()
  ]);

  // Step 3: Build fast lookup maps
  console.log("🗺️  Step 3: Building lookup maps...");
  const orderMap = new Map(existingOrders.map(o => [o.orderId, o]));
  const farmerPhoneMap = new Map();
  const salesPersonMap = new Map(salesPersons.map(s => [s.name, s]));
  const plantMap = new Map(plants.map(p => [normalizeName(p.name), p]));
  const trayMap = new Map(trays.map(t => [t.cavity, t]));
  const ensuredPlantSubtypeKeys = new Set();

  // Build farmer phone lookup
  existingFarmers.forEach(farmer => {
    if (farmer.mobileNumber) {
      farmerPhoneMap.set(farmer.mobileNumber, farmer);
    }
    if (farmer.alternateNumber) {
      farmerPhoneMap.set(farmer.alternateNumber, farmer);
    }
  });

  // Step 4: Process rows in chunks without transactions
  console.log("⚡ Step 4: Processing rows...");
  const CHUNK_SIZE = 100;
  const chunks = [];
  for (let i = 0; i < processedData.length; i += CHUNK_SIZE) {
    chunks.push(processedData.slice(i, i + CHUNK_SIZE));
  }

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    console.log(`🔄 Processing chunk ${chunkIndex + 1}/${chunks.length} (${chunk.length} rows)`);
    
    // Process each row in the chunk
    for (let i = 0; i < chunk.length; i++) {
      const row = chunk[i];
      const rowIndex = chunkIndex * CHUNK_SIZE + i;
      
      try {
        results.summary.totalProcessed++;

        // Check if order already exists
        if (orderMap.has(row.orderNumber)) {
          const existingOrder = orderMap.get(row.orderNumber);
          if (row.date) {
            await Order.updateOne(
              { _id: existingOrder._id },
              { orderBookingDate: moment(row.date, "DD-MM-YYYY").toDate() }
            );
          }
          
          results.success.push({
            bookingNo: row["Booking NO."],
            updated: true,
            message: "Order booking date updated",
          });
          results.summary.successfulImports++;
          continue;
        }

        // Process mobile number
        const mobileValue = row["Mobile No."];
        const isMissingOrDummy = !mobileValue || mobileValue === "" || mobileValue === null || 
          mobileValue === undefined || mobileValue === "dummy" || mobileValue === "Dummy" || 
          mobileValue === "DUMMY" || mobileValue === "9999999999" || mobileValue === 9999999999;

        let cleanedNumbers;
        if (isMissingOrDummy) {
          cleanedNumbers = {
            primaryNumber: null,
            alternateNumber: null,
            isInvalid: true,
            originalValue: mobileValue || "Missing",
          };
        } else {
          // Clean mobile number: remove newlines, spaces, etc.
          let cleanMobile = String(mobileValue).trim().replace(/\n/g, '').replace(/\s+/g, '');
          // Take first number if multiple
          if (cleanMobile.includes('\n') || cleanMobile.length > 10) {
            cleanMobile = cleanMobile.split(/[\s\n]+/)[0];
          }
          cleanedNumbers = cleanAndValidateMobileNumber(cleanMobile);
        }

        const primaryNumber = cleanedNumbers.primaryNumber;
        const alternateNumber = cleanedNumbers.alternateNumber;
        const isInvalidPhone = cleanedNumbers.isInvalid || !primaryNumber;
        const originalPhoneNumber = cleanedNumbers.originalValue;

        // Find or create farmer
        let farmer = null;
        if (primaryNumber && farmerPhoneMap.has(primaryNumber)) {
          farmer = farmerPhoneMap.get(primaryNumber);
        } else if (alternateNumber && farmerPhoneMap.has(alternateNumber)) {
          farmer = farmerPhoneMap.get(alternateNumber);
        }

        if (!farmer && (!primaryNumber || isInvalidPhone)) {
          farmer = await Farmer.findOne({
            name: row["Name"],
            village: row["Address"],
            taluka: row["Taluka"],
            district: row["District"]
          });
        }

        if (!farmer) {
          const farmerData = {
            name: row["Name"],
            mobileNumber: primaryNumber || null,
            alternateNumber: alternateNumber || null,
            village: row["Address"],
            taluka: row["Taluka"],
            district: row["District"],
            state: "Maharashtra",
            talukaName: row["Taluka"],
            districtName: row["District"],
            stateName: "Maharashtra",
            isInvalidPhone: isInvalidPhone,
            originalPhoneNumber: originalPhoneNumber,
          };

          farmer = await Farmer.create(farmerData);
          
          // Add to cache for future lookups
          if (primaryNumber) {
            farmerPhoneMap.set(primaryNumber, farmer);
          }
          if (alternateNumber) {
            farmerPhoneMap.set(alternateNumber, farmer);
          }
        } else {
          // Update farmer if needed
          let needsUpdate = false;
          
          if (primaryNumber && !farmer.mobileNumber) {
            farmer.mobileNumber = primaryNumber;
            needsUpdate = true;
          }
          
          if (alternateNumber && !farmer.alternateNumber) {
            farmer.alternateNumber = alternateNumber;
            needsUpdate = true;
          }
          
          if (farmer.isInvalidPhone !== isInvalidPhone) {
            farmer.isInvalidPhone = isInvalidPhone;
            needsUpdate = true;
          }
          
          if (needsUpdate) {
            await farmer.save();
          }
        }

        // Get or create sales person
        let salesPerson = salesPersonMap.get(row["Refrence"]);
        if (!salesPerson) {
          // Auto-create sales person if not found
          console.log(`🔄 Auto-creating sales person: ${row["Refrence"]}`);
          // Use the mobile number from Excel for the sales person
          const salesPersonPhoneNumber = primaryNumber || null;
          salesPerson = await createSalesPerson(row["Refrence"], salesPersonPhoneNumber);
          
          // Add to cache for future lookups
          salesPersonMap.set(row["Refrence"], salesPerson);
          
          // Add to results for tracking
          if (!results.autoCreatedSalesPersons) {
            results.autoCreatedSalesPersons = [];
          }
          results.autoCreatedSalesPersons.push({
            name: row["Refrence"],
            phoneNumber: salesPersonPhoneNumber,
            message: "Auto-created during import"
          });
        }
        
        // If no sales person found, create a default one
        if (!salesPerson) {
          salesPerson = salesPersonMap.get('Default Sales');
          
          if (!salesPerson) {
            salesPerson = await createSalesPerson('Default Sales', null);
            salesPersonMap.set('Default Sales', salesPerson);
          }
        }

        // Get plant and variety
        const plantName = row.normalizedCrop;
        const displayPlantName = row["Crop"];
        const varietyName = row.mappedVarietyName;
        const plantConfig = TARGET_PLANT_CONFIG[plantName];

        if (!plantName) {
          throw new Error(`Missing plant name for booking no ${row["Booking NO."] || "unknown"}`);
        }

        if (!varietyName) {
          throw new Error(
            `Variety not provided for plant "${displayPlantName}" at row ${rowIndex + 2}`
          );
        }

        if (plantConfig && varietyName) {
          const ensureKey = `${plantName}::${varietyName}`;
          if (!ensuredPlantSubtypeKeys.has(ensureKey)) {
            await ensurePlantAndSubtype({
              plantName,
              subtypeName: varietyName,
              plantMap,
            });
            ensuredPlantSubtypeKeys.add(ensureKey);
          }
        }

        const plant = plantMap.get(plantName);
        if (!plant) {
          throw new Error(`Plant type "${displayPlantName}" not found`);
        }

        const subtype = findSubtypeByName(plant, varietyName);
        if (!subtype) {
          throw new Error(
            `Variety "${varietyName}" not found for ${displayPlantName} (original: "${row["Variety"]}")`
          );
        }

        // Find slot
        if (!row.slots || row.slots === null || row.slots === '') {
          throw new Error(`Missing delivery date for booking ${row["Booking NO."] || "unknown"}. Expected Del. Date is required.`);
        }
        
        // Parse delivery date using UTC to prevent timezone shifts
        const deliveryDate = moment.utc(row.slots, "DD-MM-YYYY");
        if (!deliveryDate.isValid()) {
          throw new Error(`Invalid delivery date format: ${row.slots} for booking ${row["Booking NO."] || "unknown"}`);
        }

        // Add 1 day to the delivery date to fix the day shift issue
        const deliveryDatePlusOne = deliveryDate.clone().add(1, 'days');

        // Use UTC date to avoid timezone issues (set to noon UTC to prevent day shift)
        const deliveryDateUTC = moment.utc(deliveryDatePlusOne.format("YYYY-MM-DD")).hour(12).minute(0).second(0).millisecond(0);

        const slot = await findDeliverySlot(
          plant._id,
          subtype._id,
          deliveryDateUTC.toDate()
        );

        // Process tray (cavity logic)
        let tray = null;
        if (row["Media"]) {
          let cavityValue = row["Media"];
          
          // Handle different Media formats:
          // - "8 Cavity" -> extract 8
          // - "elli" or "elli cavity" -> 10
          // - Just a number -> use directly
          
          if (typeof cavityValue === "string") {
            const mediaStr = cavityValue.trim().toLowerCase();
            
            // Check for "elli" (10 cavity)
            if (mediaStr === "elli" || mediaStr.includes("elli")) {
              cavityValue = 10;
            } else if (mediaStr.includes("cavity")) {
              // Extract number from "X Cavity" format (e.g., "8 Cavity" -> 8)
              const match = mediaStr.match(/(\d+)\s*cavity/i);
              if (match && match[1]) {
                cavityValue = parseInt(match[1], 10);
              } else {
                // Try parsing the whole string as a number
                const numMatch = mediaStr.match(/\d+/);
                if (numMatch) {
                  cavityValue = parseInt(numMatch[0], 10);
                }
              }
            } else {
              // Try to parse as a number directly
              const parsed = parseInt(cavityValue.trim(), 10);
              if (!isNaN(parsed)) {
                cavityValue = parsed;
              }
            }
          }
          
          // Look up tray by cavity number
          if (typeof cavityValue === "number" && !isNaN(cavityValue)) {
            tray = trayMap.get(cavityValue);
          }
        }

        // Create order
        const totalAmount = Number(row["Plant Qty."]) * Number(row["Rate"]);
        const advanceAmount = Number(row["Advance\r\nAmt."]) || 0;
        const balanceAmount = totalAmount - advanceAmount;

        // Check if order is already dispatched based on "Del. Y/N" column (handle line breaks in column name)
        const delYN = row["Del. Y/N"] || row["Del.\r\nY/N"] || row["Del.\nY/N"];
        const delYNUpper = delYN ? delYN.toString().trim().toUpperCase() : '';
        
        // Determine order status based on Del. Y/N field:
        // Y = COMPLETED
        // TC = PENDING
        // N = ACCEPTED (default)
        let orderStatus = 'ACCEPTED'; // Default
        if (delYNUpper === 'Y') {
          orderStatus = 'COMPLETED';
        } else if (delYNUpper === 'TC') {
          orderStatus = 'PENDING';
        } else if (delYNUpper === 'N') {
          orderStatus = 'ACCEPTED';
        }

        // Check if orderId already exists in database (not just in our map)
        let finalOrderId = row.orderNumber;
        const existingOrderWithId = await Order.findOne({ orderId: finalOrderId }).lean();
        
        if (existingOrderWithId) {
          // Check if farmer is different
          const existingFarmerId = existingOrderWithId.farmer?.toString();
          const newFarmerId = farmer._id.toString();
          
          if (existingFarmerId !== newFarmerId) {
            // Farmer is different, generate a new orderId
            console.log(`⚠️  OrderId ${finalOrderId} exists with different farmer. Generating new orderId.`);
            // Generate a new orderId by appending a suffix
            const maxAttempts = 10;
            let newOrderId = finalOrderId;
            let attempt = 1;
            
            while (attempt <= maxAttempts) {
              // Try appending -1, -2, etc.
              newOrderId = parseInt(`${finalOrderId}${attempt}`);
              const checkOrder = await Order.findOne({ orderId: newOrderId }).lean();
              if (!checkOrder) {
                finalOrderId = newOrderId;
                console.log(`✅ Generated new orderId: ${finalOrderId} for farmer ${farmer.name}`);
                break;
              }
              attempt++;
            }
            
            if (attempt > maxAttempts) {
              // Fallback: use timestamp-based ID
              finalOrderId = parseInt(`${finalOrderId}${Date.now().toString().slice(-6)}`);
              console.log(`⚠️  Using timestamp-based orderId: ${finalOrderId}`);
            }
          } else {
            // Same farmer, same orderId - skip or update
            if (row.date) {
              await Order.updateOne(
                { _id: existingOrderWithId._id },
                { orderBookingDate: moment(row.date, "DD-MM-YYYY").toDate() }
              );
            }
            
            results.success.push({
              bookingNo: row["Booking NO."],
              updated: true,
              message: "Order already exists with same farmer, booking date updated",
            });
            results.summary.successfulImports++;
            continue;
          }
        }

        const orderData = {
          orderId: finalOrderId,
          farmer: farmer._id,
          salesPerson: salesPerson._id,
          numberOfPlants: row["Plant Qty."],
          rate: row["Rate"],
          plantName: plant._id,
          plantSubtype: subtype._id,
          bookingSlot: slot._id,
          cavity: tray ? tray._id : null,
          orderStatus: orderStatus,
          notes: row["Remark"] || "",
          paymentCompleted: balanceAmount <= 0,
          orderPaymentStatus: balanceAmount <= 0 ? "COMPLETED" : "PENDING",
          orderBookingDate: row.date ? moment.utc(moment(row.date, "DD-MM-YYYY").format("YYYY-MM-DD")).hour(12).toDate() : new Date(),
          deliveryDate: deliveryDateUTC.toDate(), // Set the delivery date (UTC to avoid timezone shift)
        };

        const order = await Order.create(orderData);

        // Add payment if advance exists
        if (advanceAmount > 0) {
          // Payment logic: If Ad. Amt. Mode is online, use Bank as mode. Otherwise use Ad. Amt. Mode as mode
          let paymentMode;
          const adAmtMode = row["Ad. Amt. Mode"] || '';
          const bankValue = row["Bank"] ? String(row["Bank"]) : '';
          
          if (adAmtMode && adAmtMode.toLowerCase() === 'online') {
            paymentMode = bankValue || 'online';
          } else if (adAmtMode) {
            paymentMode = adAmtMode;
          } else {
            paymentMode = bankValue || 'CASH';
          }
          
          const paymentData = {
            paidAmount: advanceAmount,
            paymentStatus: "COLLECTED",
            paymentDate: row["Advance Date"] ? moment.utc(row["Advance Date"], "DD-MM-YYYY").hour(12).toDate() : new Date(),
            bankName: row["Bank"] || "",
            modeOfPayment: paymentMode,
            remark: row["Remark"] || "",
          };

          if (row["CH No."]) {
            paymentData.remark = `${paymentData.remark} CH.No: ${row["CH No."]}`;
          }

          order.payment.push(paymentData);
          await order.save();
        }

        // Fetch slot with plant info to check if sowing is allowed
        const slotWithPlant = await PlantSlot.findOne(
          { "subtypeSlots.slots._id": slot._id },
          { "subtypeSlots.$": 1 }
        ).populate("plantId", "sowingAllowed");

        const isSowingAllowed = slotWithPlant?.plantId?.sowingAllowed || false;

        // Update slot capacity
        let excelUpdateOperation = {
          $push: { 
            "subtypeSlots.$[subtypeSlot].slots.$[slot].orders": order._id 
          },
          $inc: {
            // Always increment totalBookedPlants
            "subtypeSlots.$[subtypeSlot].slots.$[slot].totalBookedPlants": orderData.numberOfPlants
          }
        };

        // For regular plants (non-sowing-allowed), also decrement availablePlants
        if (!isSowingAllowed) {
          excelUpdateOperation.$inc["subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants"] = -orderData.numberOfPlants;
          console.log(`📊 Excel Import (Regular plant): Updating slot - totalBookedPlants +${orderData.numberOfPlants}, availablePlants -${orderData.numberOfPlants}`);
        } else {
          console.log(`📊 Excel Import (Sowing-allowed plant): Updating slot - ONLY totalBookedPlants +${orderData.numberOfPlants} (availablePlants unchanged)`);
        }

        await PlantSlot.updateOne(
          { "subtypeSlots.slots._id": slot._id },
          excelUpdateOperation,
          {
            arrayFilters: [
              { "subtypeSlot.slots._id": slot._id },
              { "slot._id": slot._id }
            ]
          }
        );

        // Get slot info for overflow check
        const slotInfo = await getSlotInfo(slot._id);

        results.success.push({
          bookingNo: row["Booking NO."],
          farmerName: farmer.name,
          orderId: order.orderId,
          amount: totalAmount,
          advancePaid: advanceAmount,
          balance: balanceAmount,
          slotInfo: slotInfo,
          phoneStatus: isInvalidPhone ? "Invalid/Missing Phone" : "Valid Phone",
          overflowWarning: slotInfo && slotInfo.isOverflow
            ? `Slot is in overflow state. Available plants: ${slotInfo.availablePlants}`
            : null,
        });

        if (slotInfo && slotInfo.isOverflow) {
          results.summary.overflowSlots++;
        }
        
        if (isInvalidPhone) {
          results.summary.invalidPhoneNumbers++;
        }

        results.summary.successfulImports++;
        
      } catch (error) {
        console.error(`❌ Error processing row ${rowIndex + 1}:`, error);
        
        // Determine error type
        let errorType = 'UNKNOWN_ERROR';
        let errorMessage = error.message;
        
        if (error.code === 11000 || error.message.includes('duplicate key')) {
          errorType = 'DUPLICATE_KEY';
          const orderIdMatch = error.message.match(/orderId[:\s]+(\d+)/);
          const orderId = orderIdMatch ? orderIdMatch[1] : row.orderNumber;
          errorMessage = `Duplicate orderId ${orderId}. Order with this ID already exists for a different farmer.`;
        } else if (error.message.includes('Missing') || error.message.includes('required')) {
          errorType = 'MISSING_DATA';
        } else if (error.message.includes('date') || error.message.includes('Date') || error.message.includes('delivery')) {
          errorType = 'DATE_ERROR';
        } else if (error.message.includes('farmer') || error.message.includes('Farmer')) {
          errorType = 'FARMER_ERROR';
        } else if (error.message.includes('plant') || error.message.includes('Plant') || error.message.includes('subtype')) {
          errorType = 'PLANT_ERROR';
        } else if (error.message.includes('slot') || error.message.includes('Slot')) {
          errorType = 'SLOT_ERROR';
        } else if (error.message.includes('Invalid') || error.message.includes('invalid')) {
          errorType = 'VALIDATION_ERROR';
        }
        
        // Save to ErrorfulOrder model
        try {
          await ErrorfulOrder.create({
            rawData: row, // Store the entire raw row data
            rowNumber: rowIndex + 2, // Excel row number (1-indexed with header)
            bookingNumber: row["Booking NO."] || null,
            parsedOrderId: row.orderNumber || null,
            errorMessage: errorMessage,
            errorType: errorType,
            sourceFilename: sourceFilename,
            importBatchId: importBatchId,
          });
          console.log(`💾 Saved errorful order to database: Row ${rowIndex + 2}, Booking ${row["Booking NO."] || "Unknown"}`);
        } catch (dbError) {
          console.error(`⚠️  Failed to save errorful order to database:`, dbError.message);
          // Continue even if saving to database fails
        }
        
        results.errors.push({
          bookingNo: row["Booking NO."] || "Unknown",
          orderId: row.orderNumber || "Unknown",
          error: errorMessage,
        });
        results.summary.failedImports++;
      }
    }
  }

  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;
  console.log(`🎉 Excel import completed in ${duration.toFixed(2)} seconds`);
  console.log(`📊 Summary: ${results.summary.successfulImports} successful, ${results.summary.failedImports} failed`);
  
  // Log auto-created sales persons
  if (results.autoCreatedSalesPersons.length > 0) {
    console.log(`👥 Auto-created ${results.autoCreatedSalesPersons.length} sales persons:`);
    results.autoCreatedSalesPersons.forEach(sp => {
      console.log(`   - ${sp.name}`);
    });
  }

  return results;
};

// Process Excel rows for validation (without saving) - identifies unprocessed rows
export const processExcelRowsForValidation = async (fileBuffer) => {
  console.log("🔍 Processing Excel rows for validation...");
  
  const workbook = XLSX.read(fileBuffer, {
    type: "buffer",
    cellDates: true,
    raw: true,
  });

  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(worksheet, {
    raw: true,
    dateNF: "DD-MM-YYYY",
    blankrows: true, // Include blank rows to process all 65 rows
  });

  const results = {
    totalRows: data.length,
    processableRows: 0,
    unprocessedRows: [],
    errors: []
  };

  // Pre-process data similar to import function
  const processedData = [];
  const uniqueSalesPersons = new Set();
  const uniquePlants = new Set();
  const uniqueTrays = new Set();

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rawCropName = normalizeName(row["Crop"]);
    const cropName = extractMainCropName(rawCropName); // Extract main crop name
    const mappedVarietyName = mapVarietyName(cropName, row["Variety"]);
    
    processedData.push({
      ...row,
      normalizedCrop: cropName,
      mappedVarietyName,
      date: convertDate(row["Date"]),
      slots: convertDate(row["Expected\r\nDel.\r\nDate"]),
    });

    uniqueSalesPersons.add(row["Refrence"]);
    if (cropName) {
      uniquePlants.add(cropName);
    }
    if (row["Media"]) {
      uniqueTrays.add(row["Media"]);
    }
  }

  // Bulk fetch reference data
  const [salesPersons, plants, trays] = await Promise.all([
    User.find({ name: { $in: Array.from(uniqueSalesPersons) }, role: "SALES" }).lean(),
    PlantCms.find({ name: { $in: Array.from(uniquePlants) } }).lean(),
    Tray.find({ cavity: { $in: Array.from(uniqueTrays).map(t => {
      if (typeof t === "string" && t.trim().toLowerCase() === "elli") return 10;
      return typeof t === "string" ? parseInt(t.trim(), 10) : t;
    }) } }).lean()
  ]);

  // Create maps for quick lookup
  const salesPersonMap = new Map(salesPersons.map(sp => [normalizeName(sp.name), sp]));
  const plantMap = new Map(plants.map(p => [normalizeName(p.name), p]));
  const trayMap = new Map(trays.map(t => [t.cavity, t]));

  // Process each row to identify issues
  for (let i = 0; i < processedData.length; i++) {
    const row = processedData[i];
    const rowErrors = [];
    
    try {
      // Check sales person
      const salesPersonName = normalizeName(row["Refrence"]);
      const salesPerson = salesPersonMap.get(salesPersonName);
      if (!salesPerson) {
        rowErrors.push(`Sales person "${row["Refrence"]}" not found`);
      }

      // Check plant
      const plantName = row.normalizedCrop;
      const plant = plantMap.get(plantName);
      if (!plant) {
        rowErrors.push(`Plant type "${row["Crop"]}" not found`);
      } else {
        // Check variety/subtype
        const varietyName = row.mappedVarietyName;
        if (varietyName) {
          const subtype = findSubtypeByName(plant, varietyName);
          if (!subtype) {
            rowErrors.push(`Variety "${row["Variety"]}" not found for ${row["Crop"]}`);
          }
        }
      }

      // Check delivery date and slot availability
      const deliveryDate = moment(row.slots, "DD-MM-YYYY");
      if (!deliveryDate.isValid()) {
        rowErrors.push(`Invalid delivery date format: ${row["Expected\r\nDel.\r\nDate"]}`);
      } else if (plant) {
        // Try to find slot for this delivery date
        try {
          const year = deliveryDate.year();
          const plantSlot = await PlantSlot.findOne({
            plantId: plant._id,
            year: year,
          });
          
          if (!plantSlot) {
            rowErrors.push(`No slots found for plant in year ${year}`);
          } else {
            const subtype = findSubtypeByName(plant, varietyName);
            if (subtype) {
              const subtypeSlot = plantSlot.subtypeSlots.find(
                (ss) => ss.subtypeId.toString() === subtype._id.toString()
              );
              
              if (!subtypeSlot) {
                rowErrors.push(`No slots found for variety "${row["Variety"]}"`);
              } else {
                // Check if slot exists for delivery date
                const deliveryDateStr = deliveryDate.format("YYYY-MM-DD");
                const normalizedDeliveryDate = moment(deliveryDateStr + 'T00:00:00');
                
                const targetSlot = subtypeSlot.slots.find((slot) => {
                  const slotStart = slot.startDay.split('-').reverse().join('-');
                  const slotEnd = slot.endDay.split('-').reverse().join('-');
                  const startMoment = moment(slotStart + 'T00:00:00');
                  const endMoment = moment(slotEnd + 'T00:00:00');
                  
                  return (
                    normalizedDeliveryDate.isSameOrAfter(startMoment, "day") &&
                    normalizedDeliveryDate.isSameOrBefore(endMoment, "day")
                  );
                });
                
                if (!targetSlot) {
                  rowErrors.push(`No slot found for delivery date ${deliveryDate.format("DD-MM-YYYY")}`);
                }
              }
            }
          }
        } catch (slotError) {
          rowErrors.push(`Slot error: ${slotError.message}`);
        }
      }

      // If no errors, row is processable
      if (rowErrors.length === 0) {
        results.processableRows++;
      } else {
        // Add to unprocessed rows with error column
        results.unprocessedRows.push({
          ...row,
          "Error": rowErrors.join("; ")
        });
        results.errors.push({
          row: i + 2,
          errors: rowErrors
        });
      }
    } catch (error) {
      rowErrors.push(error.message);
      results.unprocessedRows.push({
        ...row,
        "Error": error.message
      });
      results.errors.push({
        row: i + 2,
        errors: [error.message]
      });
    }
  }

  console.log(`📊 Validation complete: ${results.processableRows} processable, ${results.unprocessedRows.length} unprocessed`);
  
  return results;
};

async function findDeliverySlot(plantId, subtypeId, deliveryDate) {
  try {
    // Handle both Date objects and moment objects, normalize to UTC to avoid timezone shifts
    let deliveryMoment;
    if (moment.isMoment(deliveryDate)) {
      deliveryMoment = moment.utc(deliveryDate.format("YYYY-MM-DD"));
    } else if (deliveryDate instanceof Date) {
      // Extract date parts directly to avoid timezone shifts
      // Date objects from our code are already at noon UTC, but we extract parts to be safe
      const year = deliveryDate.getUTCFullYear();
      const month = deliveryDate.getUTCMonth() + 1;
      const day = deliveryDate.getUTCDate();
      deliveryMoment = moment.utc(`${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`);
    } else {
      deliveryMoment = moment.utc(deliveryDate);
    }
    
    if (!deliveryMoment.isValid()) {
      throw new Error(`Invalid delivery date: ${deliveryDate}`);
    }
    
    // Normalize to UTC date only (no time component to avoid day shifts)
    deliveryMoment = moment.utc(deliveryMoment.format("YYYY-MM-DD"));

    const year = deliveryMoment.year();
    const month = deliveryMoment.format("MMMM");

    const plantSlot = await PlantSlot.findOne({
      plantId: plantId,
      year: year,
      "subtypeSlots.subtypeId": subtypeId,
    });

    if (!plantSlot) {
      throw new Error(`No slot configuration found for plant in year ${year}`);
    }

    const subtypeSlot = plantSlot.subtypeSlots.find(
      (ss) => ss.subtypeId.toString() === subtypeId.toString()
    );

    if (!subtypeSlot) {
      throw new Error(`No slots found for subtype ${subtypeId}`);
    }

    // Normalize delivery date to midnight to avoid timezone issues
    const deliveryDateStr = deliveryMoment.format("YYYY-MM-DD");
    const normalizedDeliveryDate = moment(deliveryDateStr + 'T00:00:00');
    
    const targetSlot = subtypeSlot.slots.find((slot) => {
      const slotStart = slot.startDay.split('-').reverse().join('-');
      const slotEnd = slot.endDay.split('-').reverse().join('-');
      
      // Normalize slot dates to midnight
      const startMoment = moment(slotStart + 'T00:00:00');
      const endMoment = moment(slotEnd + 'T00:00:00');

      return (
        normalizedDeliveryDate.isSameOrAfter(startMoment, "day") &&
        normalizedDeliveryDate.isSameOrBefore(endMoment, "day")
      );
    });

    if (!targetSlot) {
      throw new Error(
        `No suitable slot found for delivery date ${normalizedDeliveryDate.format(
          "DD-MM-YYYY"
        )} in month ${month}`
      );
    }

    return targetSlot;
  } catch (error) {
    console.error("Error in findDeliverySlot:", error);
    throw error;
  }
}

// Helper function to read password-protected Excel file
export const readPasswordProtectedExcel = async (fileBuffer, password) => {
  try {
    // Write buffer to temporary file first (needed for both libraries)
    const fs = (await import('fs')).default;
    const path = (await import('path')).default;
    const os = (await import('os')).default;
    
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, `excel-${Date.now()}.xlsx`);
    
    fs.writeFileSync(tempFilePath, fileBuffer);

    try {
      // Try ExcelJS first (better password support)
      try {
        const ExcelJS = (await import('exceljs')).default;
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(tempFilePath, { password });
        
        // Convert to buffer
        const outputBuffer = await workbook.xlsx.writeBuffer();
        
        // Clean up temp file
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
        
        return outputBuffer;
      } catch (excelJSError) {
        console.log('⚠️  ExcelJS failed, trying xlsx-populate...', excelJSError.message);
        
        // Fallback to xlsx-populate
        const XlsxPopulate = (await import('xlsx-populate')).default;
        const workbook = await XlsxPopulate.fromFileAsync(tempFilePath, { password });
        const outputBuffer = await workbook.outputAsync();
        
        // Clean up temp file
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
        
        return outputBuffer;
      }
    } catch (readError) {
      // Clean up temp file on error
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
      if (readError.message && (readError.message.includes('password') || readError.message.includes('Password'))) {
        throw new Error(`Invalid password for Excel file. Please check the password and try again.`);
      }
      throw new Error(`Failed to read password-protected Excel file: ${readError.message}. Please check if the password is correct.`);
    }
  } catch (error) {
    // Re-throw with better error message
    if (error.message.includes('xlsx-populate') || error.message.includes('exceljs')) {
      throw error;
    }
    throw new Error(`Error processing password-protected Excel file: ${error.message}`);
  }
};

// New Excel import function for order structure with payment and reference fields
export const importOrdersFromExcel = async (fileBuffer, options = {}) => {
  console.log("🚀 Starting Excel order import with payment and reference fields...");
  
  const importBatchId = options.importBatchId || `import-${Date.now()}`;
  const sourceFilename = options.sourceFilename || 'unknown.xlsx';
  const rowLimit = options.rowLimit ? parseInt(options.rowLimit) : null;
  
  // Handle password-protected files
  let processedBuffer = fileBuffer;
  if (options.password) {
    console.log("🔐 Password provided, attempting to decrypt Excel file...");
    try {
      processedBuffer = await readPasswordProtectedExcel(fileBuffer, options.password);
      console.log("✅ Successfully decrypted password-protected Excel file");
    } catch (passwordError) {
      console.error("❌ Error decrypting password-protected file:", passwordError.message);
      throw new Error(`Failed to decrypt Excel file: ${passwordError.message}`);
    }
  }
  
  const results = {
    success: 0,
    failed: 0,
    errors: [],
    autoCreatedFarmers: [],
    autoCreatedSalesPersons: [],
    autoCreatedTrays: [],
    autoCreatedReferenceUsers: [],
    skipped: [],
    errorfulOrders: [], // Track all errorful orders for retry
  };

  try {
    // Parse Excel file (use processed buffer which may be decrypted)
    const workbook = XLSX.read(processedBuffer, { type: "buffer", cellDates: false });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: null });

    if (rows.length === 0) {
      throw new Error("Excel file is empty");
    }

    console.log(`📊 Found ${rows.length} rows in Excel file`);

    // Caching maps
    const farmerPhoneMap = new Map();
    const plantMap = new Map();
    const salesPersonMap = new Map();
    const trayMap = new Map();

    // Pre-load all farmers by mobile number
    const allFarmers = await Farmer.find({}).lean();
    allFarmers.forEach((farmer) => {
      if (farmer.mobileNumber) {
        farmerPhoneMap.set(farmer.mobileNumber.toString(), farmer);
      }
      if (farmer.alternateNumber) {
        farmerPhoneMap.set(farmer.alternateNumber.toString(), farmer);
      }
    });

    // Pre-load all plants
    const allPlants = await PlantCms.find({}).lean();
    allPlants.forEach((plant) => {
      plantMap.set(plant.name.toLowerCase().trim(), plant);
    });

    // Pre-load all sales persons
    const allSalesPersons = await User.find({ 
      $or: [{ jobTitle: "SALES" }, { role: "SALES" }, { role: "DEALER" }] 
    }).lean();
    allSalesPersons.forEach((person) => {
      salesPersonMap.set(person.name?.toLowerCase().trim(), person);
    });

    // Pre-load all trays
    const allTrays = await Tray.find({ isActive: true }).lean();
    allTrays.forEach((tray) => {
      trayMap.set(tray.cavity.toString(), tray);
    });

    // Apply row limit if specified
    const rowsToProcess = rowLimit && rowLimit > 0 
      ? rows.slice(0, rowLimit) 
      : rows;
    
    console.log(`📊 Processing ${rowsToProcess.length} row(s)${rowLimit ? ` (limited to first ${rowLimit} rows)` : ' (all rows)'} out of ${rows.length} total rows`);

    // Process each row
    for (let rowIndex = 0; rowIndex < rowsToProcess.length; rowIndex++) {
      const row = rowsToProcess[rowIndex];
      
      try {
        // Skip empty rows
        if (!row["Name"] && !row["Mobile No."] && !row["Booking NO."]) {
          continue;
        }

        // 1. Parse Date (Booking Date)
        let bookingDate = null;
        if (row["Date"]) {
          const dateStr = convertDate(row["Date"]);
          if (dateStr) {
            bookingDate = moment.utc(dateStr, "DD-MM-YYYY").toDate();
          }
        }
        if (!bookingDate) {
          bookingDate = new Date();
        }

        // 2. Generate Booking NO. (Year + Month + Sequence)
        let bookingNo = row["Booking NO."];
        if (!bookingNo || bookingNo === "" || bookingNo === 0) {
          const year = moment(bookingDate).format("YYYY");
          const month = moment(bookingDate).format("MM");
          const maxOrder = await Order.findOne().sort({ orderId: -1 }).select("orderId").lean();
          const sequence = maxOrder ? (maxOrder.orderId % 1000) + 1 : 1;
          bookingNo = `${year}${month}${sequence.toString().padStart(3, "0")}`;
        }

        // 3. Find or create farmer by mobile number
        let farmer = null;
        const mobileValue = row["Mobile No."];
        
        if (mobileValue) {
          const cleanedNumbers = cleanAndValidateMobileNumber(String(mobileValue).trim());
          const primaryNumber = cleanedNumbers.primaryNumber;
          
          if (primaryNumber && farmerPhoneMap.has(primaryNumber)) {
            farmer = farmerPhoneMap.get(primaryNumber);
          } else if (primaryNumber) {
            // Create new farmer
            farmer = new Farmer({
              name: row["Name"] || "Unknown",
              mobileNumber: Number(primaryNumber),
              village: row["Address"] || "",
              taluka: row["Taluka"] || "",
              district: row["District"] || "",
              stateName: "Maharashtra",
              talukaName: row["Taluka"] || "",
              districtName: row["District"] || "",
              state: "MH",
              isInvalidPhone: cleanedNumbers.isInvalid || false,
              originalPhoneNumber: cleanedNumbers.originalValue || null,
            });
            await farmer.save();
            farmerPhoneMap.set(primaryNumber, farmer);
            results.autoCreatedFarmers.push({
              name: farmer.name,
              mobileNumber: primaryNumber,
            });
          }
        }
        
        if (!farmer) {
          // Try to find by name and location
          farmer = await Farmer.findOne({
            name: row["Name"],
            village: row["Address"] || "",
            taluka: row["Taluka"] || "",
            district: row["District"] || "",
          });
          
          if (!farmer) {
            // Create farmer without mobile
            farmer = new Farmer({
              name: row["Name"] || "Unknown",
              village: row["Address"] || "",
              taluka: row["Taluka"] || "",
              district: row["District"] || "",
              stateName: "Maharashtra",
              talukaName: row["Taluka"] || "",
              districtName: row["District"] || "",
              state: "MH",
              isInvalidPhone: true,
            });
            await farmer.save();
            results.autoCreatedFarmers.push({
              name: farmer.name,
              mobileNumber: null,
            });
          }
        }

        // 4. Find or create plant and subtype
        const cropName = (row["Crop"] || "").toString().trim();
        const varietyName = (row["Variety"] || "").toString().trim();
        
        if (!cropName || !varietyName) {
          throw new Error(`Missing Crop or Variety at row ${rowIndex + 2}`);
        }

        const plant = plantMap.get(cropName.toLowerCase());
        if (!plant) {
          throw new Error(`Plant "${cropName}" not found at row ${rowIndex + 2}`);
        }

        const subtype = plant.subtypes.find(
          (st) => st.name?.toLowerCase().trim() === varietyName.toLowerCase().trim()
        );
        if (!subtype) {
          throw new Error(`Variety "${varietyName}" not found for "${cropName}" at row ${rowIndex + 2}`);
        }

        // 5. Find or create tray (cavity)
        let tray = null;
        if (row["Media"]) {
          const cavityValue = row["Media"].toString().trim();
          
          // Extract cavity number from strings like "8 Cavity" or "8 cavity" or just "8"
          let cavityNumber = parseInt(cavityValue, 10);
          if (isNaN(cavityNumber)) {
            // Try to extract number from string like "8 Cavity"
            const match = cavityValue.match(/(\d+)/);
            if (match) {
              cavityNumber = parseInt(match[1], 10);
            }
          }
          
          // Try to find in cache by original value or cavity number
          tray = trayMap.get(cavityValue) || trayMap.get(cavityNumber.toString());
          
          if (!tray) {
            // Try to find by name or cavity number
            tray = await Tray.findOne({ 
              $or: [
                { name: cavityValue },
                { cavity: cavityNumber }
              ]
            });
            
            if (tray) {
              trayMap.set(cavityValue, tray);
              trayMap.set(cavityNumber.toString(), tray);
            } else if (!isNaN(cavityNumber) && cavityNumber > 0) {
              // Create new tray if not found (use extracted cavity number)
              console.log(`🔄 Auto-creating tray for Media: ${cavityValue} (cavity: ${cavityNumber})`);
              tray = await createTray(cavityNumber.toString());
              trayMap.set(cavityValue, tray);
              trayMap.set(cavityNumber.toString(), tray);
              
              // Add to results for tracking
              if (!results.autoCreatedTrays) {
                results.autoCreatedTrays = [];
              }
              results.autoCreatedTrays.push({
                name: tray.name,
                cavity: tray.cavity,
                message: "Auto-created during import"
              });
            }
          }
        }

        // 6. Parse delivery dates and determine slot
        let deliveryDate = null;
        let oldDeliveryDate = null;
        let slot = null;
        let slotDate = null;

        // Parse Expected Del. Date
        if (row["Expected Del."]) {
          const expectedDelStr = convertDate(row["Expected Del."]);
          if (expectedDelStr) {
            deliveryDate = moment.utc(expectedDelStr, "DD-MM-YYYY").hour(12).toDate();
          }
        }

        // Parse Old Del. Date
        if (row["Old Del. Date"]) {
          const oldDelStr = convertDate(row["Old Del. Date"]);
          if (oldDelStr) {
            oldDeliveryDate = moment.utc(oldDelStr, "DD-MM-YYYY").hour(12).toDate();
          }
        }

        // Logic: If Old Del. Date is present, it's the slot date, and deliveryDate should be N/A (null)
        // If Old Del. Date is not present, oldDeliveryDate should be slot date (which is deliveryDate)
        if (oldDeliveryDate) {
          slotDate = oldDeliveryDate;
          deliveryDate = null; // Set deliveryDate to N/A when Old Del. Date is present
        } else if (deliveryDate) {
          slotDate = deliveryDate;
          oldDeliveryDate = deliveryDate; // Set oldDeliveryDate to slot date
        } else {
          throw new Error(`Missing delivery date at row ${rowIndex + 2}`);
        }

        // Find slot for slotDate
        slot = await findDeliverySlot(plant._id, subtype._id, slotDate);

        // 7. Parse order status from Del. Y/N
        let orderStatus = "ACCEPTED";
        const delYN = (row["Del. Y/N"] || "").toString().trim().toUpperCase();
        if (delYN === "Y") {
          orderStatus = "COMPLETED";
        } else if (delYN === "N") {
          orderStatus = "ACCEPTED";
        } else if (delYN === "C") {
          orderStatus = "CANCELLED";
        } else if (delYN === "TC") {
          orderStatus = "CANCELLED"; // Temporary cancelled
        }

        // 8. Find or create sales person (Order By)
        let salesPerson = null;
        const orderByName = (row["Order By"] || "").toString().trim();
        
        if (orderByName) {
          salesPerson = salesPersonMap.get(orderByName.toLowerCase());
          
          if (!salesPerson) {
            // Try to find in database
            salesPerson = await User.findOne({
              name: orderByName,
              $or: [{ jobTitle: "SALES" }, { role: "SALES" }, { role: "DEALER" }]
            });
            
            if (salesPerson) {
              salesPersonMap.set(orderByName.toLowerCase(), salesPerson);
            } else {
              // Create new sales person with dummy number
              const dummyPhone = `9999999${Math.floor(1000 + Math.random() * 9000)}`;
              salesPerson = await createSalesPerson(orderByName, dummyPhone);
              salesPersonMap.set(orderByName.toLowerCase(), salesPerson);
              results.autoCreatedSalesPersons.push({
                name: orderByName,
                phoneNumber: dummyPhone,
              });
            }
          }
        }

        if (!salesPerson) {
          // Create default sales person
          salesPerson = salesPersonMap.get("default sales");
          if (!salesPerson) {
            salesPerson = await createSalesPerson("Default Sales", null);
            salesPersonMap.set("default sales", salesPerson);
          }
        }

        // 9. Find or create reference user (Reference field)
        let referenceUser = null;
        const referenceName = (row["Refrence"] || "").toString().trim();
        
        if (referenceName) {
          referenceUser = salesPersonMap.get(referenceName.toLowerCase());
          
          if (!referenceUser) {
            // Try to find in database
            referenceUser = await User.findOne({ name: referenceName });
            
            if (referenceUser) {
              salesPersonMap.set(referenceName.toLowerCase(), referenceUser);
            } else {
              // Create new reference user if not found
              console.log(`🔄 Auto-creating reference user: ${referenceName}`);
              referenceUser = await createReferenceUser(referenceName, null);
              salesPersonMap.set(referenceName.toLowerCase(), referenceUser);
              
              // Add to results for tracking
              if (!results.autoCreatedReferenceUsers) {
                results.autoCreatedReferenceUsers = [];
              }
              results.autoCreatedReferenceUsers.push({
                name: referenceName,
                phoneNumber: referenceUser.phoneNumber,
                message: "Auto-created during import"
              });
            }
          }
        }

        // 10. Create order
        const numberOfPlants = parseInt(row["Plant Qty."] || 0);
        const rate = parseFloat(row["Rate"] || 0);
        const expectedNursery = (row["Expected"] || "").toString().trim();

        // Check if order already exists by orderId
        const parsedOrderId = parseOrderId(bookingNo);
        const existingOrder = await Order.findOne({ orderId: parsedOrderId });
        
        if (existingOrder) {
          results.skipped.push({
            row: rowIndex + 2,
            bookingNo: bookingNo,
            reason: "Order already exists",
          });
          continue;
        }

        const order = new Order({
          orderId: parsedOrderId,
          farmer: farmer._id,
          salesPerson: salesPerson._id,
          numberOfPlants: numberOfPlants,
          plantName: plant._id,
          plantSubtype: subtype._id,
          bookingSlot: slot._id,
          cavity: tray?._id,
          rate: rate,
          orderStatus: orderStatus,
          orderBookingDate: bookingDate,
          deliveryDate: deliveryDate || slotDate,
          oldDeliveryDate: oldDeliveryDate,
          expectedNursery: expectedNursery || null,
          reference: referenceUser?._id || null,
          orderPaymentStatus: "PENDING",
          payment: [],
        });

        await order.save();

        // 11. Create payment entry if advance amount exists
        if (row["Advance Amt."] && parseFloat(row["Advance Amt."]) > 0) {
          const advanceAmount = parseFloat(row["Advance Amt."]);
          const advanceDate = row["Advance On"] 
            ? moment.utc(convertDate(row["Advance On"]), "DD-MM-YYYY").toDate()
            : bookingDate;
          
          const advYN = (row["ADV Y/N"] || "").toString().trim().toUpperCase();
          const paymentStatus = advYN === "Y" ? "COLLECTED" : "PENDING";
          
          // Handle payment mode - if mode is "Bank" or similar, use bank field
          let modeOfPayment = (row["Ad. Amt. Mode"] || "").toString().trim();
          let bankName = (row["Bank"] || "").toString().trim() || null;
          
          // If payment mode is "Bank", "Bank Transfer", or similar, ensure bank name is set
          const bankModes = ["bank", "bank transfer", "neft", "rtgs", "neft/rtgs"];
          if (bankModes.includes(modeOfPayment.toLowerCase())) {
            // If bank name is not provided but mode is bank-related, use mode as bank name
            if (!bankName) {
              bankName = modeOfPayment;
            }
            // Set mode to NEFT/RTGS if it's a bank transfer
            if (modeOfPayment.toLowerCase().includes("neft") || modeOfPayment.toLowerCase().includes("rtgs")) {
              modeOfPayment = "NEFT/RTGS";
            } else if (modeOfPayment.toLowerCase().includes("bank")) {
              modeOfPayment = "Bank Transfer";
            }
          }
          
          // Default to Cash if no mode specified
          if (!modeOfPayment) {
            modeOfPayment = "Cash";
          }
          
          const payment = {
            paidAmount: advanceAmount,
            paymentDate: advanceDate,
            paymentStatus: paymentStatus,
            modeOfPayment: modeOfPayment,
            bankName: bankName,
            chequeNumber: (row["CH No."] || "").toString().trim() || null,
            remark: row["Remark"] || null,
            receiptPhoto: [],
            isWalletPayment: false,
          };

          // Add payment to order
          order.payment.push(payment);
          await order.save();
        }

        results.success++;
        console.log(`✅ Row ${rowIndex + 2}: Order ${bookingNo} created successfully`);

      } catch (error) {
        results.failed++;
        const errorMsg = error.message;
        const fullErrorMsg = `Row ${rowIndex + 2}: ${errorMsg}`;
        results.errors.push(fullErrorMsg);
        console.error(`❌ ${fullErrorMsg}`);

        // Determine error type
        let errorType = 'UNKNOWN_ERROR';
        const errorMessageLower = errorMsg.toLowerCase();
        
        if (errorMessageLower.includes('missing') || errorMessageLower.includes('required')) {
          errorType = 'MISSING_DATA';
        } else if (errorMessageLower.includes('duplicate') || errorMessageLower.includes('already exists')) {
          errorType = 'DUPLICATE_KEY';
        } else if (errorMessageLower.includes('date') || errorMessageLower.includes('invalid date')) {
          errorType = 'DATE_ERROR';
        } else if (errorMessageLower.includes('farmer') || errorMessageLower.includes('mobile')) {
          errorType = 'FARMER_ERROR';
        } else if (errorMessageLower.includes('plant') || errorMessageLower.includes('crop') || errorMessageLower.includes('variety')) {
          errorType = 'PLANT_ERROR';
        } else if (errorMessageLower.includes('slot') || errorMessageLower.includes('delivery')) {
          errorType = 'SLOT_ERROR';
        } else if (errorMessageLower.includes('validation') || errorMessageLower.includes('invalid')) {
          errorType = 'VALIDATION_ERROR';
        }

        // Try to parse booking number and order ID
        let bookingNumber = row["Booking NO."] || null;
        let parsedOrderId = null;
        
        if (bookingNumber) {
          try {
            parsedOrderId = parseOrderId(bookingNumber);
          } catch (parseError) {
            // Ignore parsing errors
          }
        }

        // Save to ErrorfulOrder model
        let errorfulOrderDoc = null;
        try {
          errorfulOrderDoc = await ErrorfulOrder.create({
            rawData: row, // Store the entire raw row data
            rowNumber: rowIndex + 2, // Excel row number (1-indexed with header)
            bookingNumber: bookingNumber ? String(bookingNumber) : null,
            parsedOrderId: parsedOrderId,
            errorMessage: errorMsg,
            errorType: errorType,
            sourceFilename: sourceFilename,
            importBatchId: importBatchId,
          });
          console.log(`💾 Saved errorful order to database: Row ${rowIndex + 2}, Booking ${bookingNumber || "Unknown"}`);
          
          // Add to results for tracking
          results.errorfulOrders.push({
            row: rowIndex + 2,
            bookingNumber: bookingNumber,
            errorMessage: errorMsg,
            errorType: errorType,
            errorfulOrderId: errorfulOrderDoc._id,
          });
        } catch (dbError) {
          console.error(`⚠️  Failed to save errorful order to database:`, dbError.message);
          // Continue even if saving to database fails
        }
      }
    }

    console.log(`\n📊 Import Summary:`);
    console.log(`   ✅ Success: ${results.success}`);
    console.log(`   ❌ Failed: ${results.failed}`);
    console.log(`   🔄 Skipped: ${results.skipped.length}`);
    console.log(`   👤 Auto-created Farmers: ${results.autoCreatedFarmers.length}`);
    console.log(`   👥 Auto-created Sales Persons: ${results.autoCreatedSalesPersons.length}`);
    console.log(`   📦 Auto-created Trays: ${results.autoCreatedTrays?.length || 0}`);
    console.log(`   👤 Auto-created Reference Users: ${results.autoCreatedReferenceUsers?.length || 0}`);
    console.log(`   📋 Errorful Orders Stored: ${results.errorfulOrders.length}`);

    return results;

  } catch (error) {
    console.error("❌ Fatal error in Excel import:", error);
    throw error;
  }
};

// Function to retry importing errorful orders after clearing faults
export const retryErrorfulOrders = async (options = {}) => {
  console.log("🔄 Starting retry of errorful orders...");
  
  const importBatchId = options.importBatchId || `retry-${Date.now()}`;
  const filter = options.filter || { isResolved: false, successfullyImported: false };
  const limit = options.limit || null; // null means all
  
  const results = {
    success: 0,
    failed: 0,
    errors: [],
    retried: [],
  };

  try {
    // Get all unresolved errorful orders
    let query = ErrorfulOrder.find(filter).sort({ createdAt: 1 });
    if (limit) {
      query = query.limit(limit);
    }
    
    const errorfulOrders = await query.lean();
    
    if (errorfulOrders.length === 0) {
      console.log("✅ No errorful orders to retry");
      return results;
    }

    console.log(`📋 Found ${errorfulOrders.length} errorful orders to retry`);

    // Process each errorful order
    for (const errorfulOrder of errorfulOrders) {
      try {
        const row = errorfulOrder.rawData;
        
        // Create a mock Excel buffer with just this row
        // XLSX.utils.json_to_sheet automatically uses object keys as headers
        const XLSX = (await import('xlsx')).default;
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet([row], { defval: null });
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Orders');
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        // Import this single order
        const importResults = await importOrdersFromExcel(buffer, {
          importBatchId: `${importBatchId}-retry`,
          sourceFilename: errorfulOrder.sourceFilename || 'retry-import.xlsx',
          password: null,
        });

        if (importResults.success > 0) {
          // Find the newly created order (most recent order with matching booking number or parsed order ID)
          let importedOrder = null;
          if (errorfulOrder.parsedOrderId) {
            importedOrder = await Order.findOne({ orderId: errorfulOrder.parsedOrderId }).lean();
          }
          if (!importedOrder) {
            // Find most recently created order
            importedOrder = await Order.findOne().sort({ createdAt: -1 }).lean();
          }
          
          await ErrorfulOrder.findByIdAndUpdate(errorfulOrder._id, {
            isResolved: true,
            successfullyImported: true,
            importedOrderId: importedOrder?._id || null,
            resolvedAt: new Date(),
            retryAttempts: (errorfulOrder.retryAttempts || 0) + 1,
            lastRetryAt: new Date(),
          });

          results.success++;
          results.retried.push({
            errorfulOrderId: errorfulOrder._id,
            bookingNumber: errorfulOrder.bookingNumber,
            orderId: importedOrder?.orderId || null,
            status: 'success',
          });
          
          console.log(`✅ Retry successful for order: ${errorfulOrder.bookingNumber || 'Unknown'}`);
        } else {
          // Update retry attempts but keep as unresolved
          await ErrorfulOrder.findByIdAndUpdate(errorfulOrder._id, {
            retryAttempts: (errorfulOrder.retryAttempts || 0) + 1,
            lastRetryAt: new Date(),
          });

          results.failed++;
          const errorMsg = importResults.errors && importResults.errors.length > 0 
            ? importResults.errors[0] 
            : 'Import failed';
          results.errors.push({
            errorfulOrderId: errorfulOrder._id,
            bookingNumber: errorfulOrder.bookingNumber,
            error: errorMsg,
          });
          
          console.log(`❌ Retry failed for order: ${errorfulOrder.bookingNumber || 'Unknown'}`);
        }
      } catch (error) {
        results.failed++;
        results.errors.push({
          errorfulOrderId: errorfulOrder._id,
          bookingNumber: errorfulOrder.bookingNumber,
          error: error.message,
        });
        
        // Update retry attempts
        await ErrorfulOrder.findByIdAndUpdate(errorfulOrder._id, {
          retryAttempts: (errorfulOrder.retryAttempts || 0) + 1,
          lastRetryAt: new Date(),
        });
        
        console.error(`❌ Error retrying order ${errorfulOrder.bookingNumber || 'Unknown'}:`, error.message);
      }
    }

    console.log(`\n📊 Retry Summary:`);
    console.log(`   ✅ Success: ${results.success}`);
    console.log(`   ❌ Failed: ${results.failed}`);
    console.log(`   🔄 Total Retried: ${results.retried.length + results.errors.length}`);

    return results;
  } catch (error) {
    console.error("❌ Fatal error in retry:", error);
    throw error;
  }
};
