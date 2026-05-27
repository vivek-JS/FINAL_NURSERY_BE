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
import {
  ensureFarmerPlantOrderDebit,
  recordFarmerPlantLedgerPaymentTransition,
} from "../utils/farmerPlantOrderLedgerHelper.js";
import { sanitizePaymentArrayForOrder } from "../utils/paymentTiming.js";
import {
  allocateNextOrderId,
  reserveOrderId,
} from "../services/orderIdAllocation.service.js";

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

// Function to parse order ID from various formats
function parseOrderId(bookingNo) {
  // Check if bookingNo is null, undefined, or empty string (but allow 0)
  if (bookingNo === null || bookingNo === undefined || bookingNo === '') {
    throw new Error("Booking number is required");
  }

  const bookingStr = bookingNo.toString().trim();
  const numericValue = parseInt(bookingStr, 10);

  // Booking 0 — orderId comes from allocator, not from sheet
  if (numericValue === 0) {
    return null;
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

  // Unknown format — orderId comes from allocator; keep booking in notes
  console.log(`⚠️  Unknown booking number format: "${bookingStr}" (legacy reference only)`);
  return null;
}

const splitFarmerName = (rawName) => {
  const normalized = (rawName || "")
    .toString()
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  return {
    primaryName: normalized[0] || "Unknown Farmer",
    additionalNames: normalized.slice(1),
  };
};

const parseBooleanLike = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const normalized = (value || "").toString().trim().toUpperCase();
  return ["Y", "YES", "TRUE", "1"].includes(normalized);
};

const readAdvMatched = (row) => {
  const advMatchOrNot = row["adv match or not"] || row["adv\r\nmatch\r\nor\r\nnot"] || row["adv\nmatch\nor\nnot"];
  const advYN = row["ADV Y/N"] || row["ADV\r\nY/N"] || row["ADV\nY/N"];
  return parseBooleanLike(advYN) || parseBooleanLike(advMatchOrNot);
};

const readExpectedDeliveryRaw = (row) => {
  return (
    row["Expected\r\nDel.\r\nDate"] ??
    row["Expected\nDel.\nDate"] ??
    row["Expected Del. Date"] ??
    row["Expected Del Date"] ??
    row["Expected Delivery Date"] ??
    row["Expected\r\nDelivery\r\nDate"] ??
    null
  );
};

const findMatchingEmployeeByReference = (referenceValue, employees) => {
  const q = (referenceValue || "").toString().trim().toLowerCase();
  if (!q) return null;

  const matches = (employees || []).filter((u) => {
    const n = (u?.name || "").toString().trim().toLowerCase();
    if (!n) return false;
    return n.includes(q) || q.includes(n);
  });

  if (!matches.length) return null;
  matches.sort((a, b) => ((b.name || "").length - (a.name || "").length));
  return matches[0];
};

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

// Helper function to fix invalid slotTrail entries in a PlantSlot document
const fixInvalidSlotTrailInDocument = async (plantSlotDoc) => {
  const activityNameMap = {
    'ADD': 'Plants Added',
    'SUBTRACT': 'Plants Subtracted',
    'BUFFER_APPLIED': 'Buffer Applied',
    'BUFFER_RELEASED': 'Buffer Released',
    'ADD_WITH_BUFFER': 'Plants Added with Buffer',
    'ADD_WITH_BUFFER_RELEASE': 'Plants Added with Buffer Release',
    'SUBTRACT_WITH_BUFFER': 'Plants Subtracted with Buffer',
    'SUBTRACT_WITH_BUFFER_RELEASE': 'Plants Subtracted with Buffer Release',
    'UPDATE': 'Slot Updated',
    'ORDER_CANCELLED': 'Order Cancelled',
    'ORDER_RETURNED': 'Order Returned',
    'SOWING_STARTED': 'Sowing Started',
    'SOWING_COMPLETED': 'Sowing Completed',
    'SOWING_CANCELLED': 'Sowing Cancelled',
    'SOWING_PRIMARY': 'Primary Location Sowing',
    'SOWING_OFFICE': 'Office Location Sowing',
    'SOWING_EXCESSIVE': 'Excessive Sowing',
    'EXCESSIVE_SOWING_ADDED': 'Excessive Sowing Added',
    'STOCK_REQUEST_CREATED': 'Stock Request Created',
    'STOCK_REQUEST_ISSUED': 'Stock Request Issued',
    'STOCK_REQUEST_CANCELLED': 'Stock Request Cancelled',
    'GAP_COVERED': 'Gap Covered',
    'SOWING_IN_PROGRESS_CLEARED': 'Sowing In Progress Cleared',
    'PACKETS_RETURNED': 'Packets Returned',
    'PACKETS_USED': 'Packets Used',
  };

  const getActivityName = (action) => {
    if (!action) return 'Unknown Activity';
    return activityNameMap[action] || action.replace(/_/g, ' ');
  };

  let fixedCount = 0;
  for (const subtypeSlot of plantSlotDoc.subtypeSlots || []) {
    for (const s of subtypeSlot.slots || []) {
      if (s.slotTrail && s.slotTrail.length > 0) {
        for (const trail of s.slotTrail) {
          // Check if activityName is missing, empty, or invalid
          if (!trail.activityName || 
              trail.activityName === 'undefined' || 
              trail.activityName.trim().length < 2) {
            const newActivityName = getActivityName(trail.action);
            trail.activityName = newActivityName;
            fixedCount++;
          }
        }
      }
    }
  }
  
  if (fixedCount > 0) {
    console.log(`✅ Fixed ${fixedCount} invalid slotTrail entries in PlantSlot ${plantSlotDoc._id}`);
  }
  
  return fixedCount;
};

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

  // Normalize by removing hyphens and spaces for comparison
  const normalizeForComparison = (name) => {
    return normalizeName(name).toLowerCase().replace(/-/g, '').replace(/\s+/g, '');
  };

  const targetName = normalizeForComparison(subtypeName);
  return plant.subtypes.find(
    (subtype) => normalizeForComparison(subtype.name) === targetName
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
      try {
        await existingYearSlots.save();
      } catch (error) {
        // If validation fails due to invalid slotTrail entries, fix them first
        if (error.message.includes('activityName')) {
          console.log(`⚠️ Found invalid slotTrail entries, fixing before save...`);
          await fixInvalidSlotTrailInDocument(existingYearSlots);
          await existingYearSlots.save();
        } else {
          throw error;
        }
      }
    } else if (!subtypeSlotEntry.slots || subtypeSlotEntry.slots.length === 0) {
      subtypeSlotEntry.slots = slots;
      try {
        await existingYearSlots.save();
      } catch (error) {
        // If validation fails due to invalid slotTrail entries, fix them first
        if (error.message.includes('activityName')) {
          console.log(`⚠️ Found invalid slotTrail entries, fixing before save...`);
          await fixInvalidSlotTrailInDocument(existingYearSlots);
          await existingYearSlots.save();
        } else {
          throw error;
        }
      }
    }
  }
};

const ensurePlantAndSubtype = async ({
  plantName,
  subtypeName,
  plantMap,
}) => {
  const config = TARGET_PLANT_CONFIG[plantName];
  
  // Default configuration for plants not in TARGET_PLANT_CONFIG
  const defaultConfig = {
    slotSize: 7,
    plantReadyDays: 0,
    sowingAllowed: false,
    slotDays: 7,
    slotCapacity: 100000,
    slotStartDate: '01-01-2025',
    slotEndDate: '31-12-2026'
  };
  
  const effectiveConfig = config || defaultConfig;

  const normalizedSubtypeName = normalizeName(subtypeName);

  if (!normalizedSubtypeName) {
    return plantMap.get(plantName) || null;
  }

  let plantEntry = plantMap.get(plantName);
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
  } else {
    plantDoc = await PlantCms.findById(plantEntry._id);

    if (!plantDoc) {
      plantMap.delete(plantName);
      return null;
    }

    // Update plant config if needed (only for TARGET_PLANT_CONFIG plants)
    if (config) {
      if (plantDoc.slotSize !== config.slotSize) {
        plantDoc.slotSize = config.slotSize;
        isDirty = true;
      }

      if (!plantDoc.sowingAllowed && config.sowingAllowed) {
        plantDoc.sowingAllowed = true;
        isDirty = true;
      }
    }

    const existingSubtype = findSubtypeByName(
      plantDoc,
      normalizedSubtypeName
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
      if (config && existingSubtype.plantReadyDays !== config.plantReadyDays) {
        existingSubtype.plantReadyDays = config.plantReadyDays;
        isDirty = true;
      }
    }

    if (isDirty) {
      await plantDoc.save();
    }
  }

  const subtype = findSubtypeByName(plantDoc, normalizedSubtypeName);

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
  const dryRun = !!options.dryRun;

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
    dryRun: dryRun,
    dryRunActions: [],
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
  const validPhoneNumbers = new Set();
  const usedOrderIds = new Set();

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    
    // Skip completely empty rows (no booking number, no name, no crop)
    if (!row["Booking NO."] && !row["Name"] && !row["Crop"]) {
      console.log(`⏭️  Skipping empty row ${i + 2}`);
      continue;
    }

    const legacyBookingRef =
      row["Booking NO."] !== null &&
      row["Booking NO."] !== undefined &&
      row["Booking NO."] !== ""
        ? String(row["Booking NO."]).trim()
        : null;

    const rawCropName = normalizeName(row["Crop"]);
    const cropName = extractMainCropName(rawCropName); // Extract main crop name
    const mappedVarietyName = mapVarietyName(cropName, row["Variety"]);
    
    processedData.push({
      ...row,
      legacyBookingRef,
      normalizedCrop: cropName,
      mappedVarietyName,
      date: convertDate(row["Date"]),
      slots: convertDate(readExpectedDeliveryRaw(row)),
      "Advance Date": row["Advance\r\nDate"] ? convertDate(row["Advance\r\nDate"]) : null,
    });
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

  // Step 2: Bulk fetch all reference data first
  console.log("📥 Step 2: Bulk fetching reference data...");
  const [
    existingFarmers,
    salesPersons,
    plants,
    trays
  ] = await Promise.all([
    Farmer.find({
      $or: [
        { mobileNumber: { $in: Array.from(validPhoneNumbers) } },
        { alternateNumber: { $in: Array.from(validPhoneNumbers) } }
      ]
    }).lean(),
    User.find({ role: { $in: ["SALES", "DEALER"] } }).lean(),
    PlantCms.find({ name: { $in: Array.from(uniquePlants) } }).lean(),
    Tray.find({
      cavity: {
        $in: Array.from(uniqueTrays)
          .map((t) =>
            typeof t === "string" && t.trim().toLowerCase() === "elli"
              ? 10
              : parseInt(t, 10)
          )
          .filter((n) => Number.isFinite(n)),
      },
    }).lean()
  ]);

  // Build plant map using existing CMS data only (strict mode: no auto-create).
  const plantMap = new Map(plants.map(p => [normalizeName(p.name), p]));

  // Step 3: Build fast lookup maps
  console.log("🗺️  Step 3: Building lookup maps...");
  const farmerPhoneMap = new Map();
  const salesPersonMap = new Map(salesPersons.map(s => [normalizeName(s.name), s]));
  
  // Build tray map: key by cavity number, also map by aliases
  const trayMap = new Map();
  trays.forEach(t => {
    // Map by cavity number
    trayMap.set(t.cavity, t);
    // Also map by aliases if they exist
    if (t.aliases && Array.isArray(t.aliases)) {
      t.aliases.forEach(alias => {
        // Store reference to the tray for alias lookups
        const aliasKey = alias.toLowerCase();
        if (!trayMap.has(aliasKey)) {
          trayMap.set(aliasKey, t);
        }
      });
    }
  });
  
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

        // Intentionally do not skip existing order IDs; requirement is to always create a new order row.

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

        const { primaryName, additionalNames } = splitFarmerName(row["Name"]);
        const farmerRemarkSuffix = additionalNames.length > 0
          ? `Additional names: ${additionalNames.join(", ")}`
          : null;

        if (!farmer) {
          const farmerData = {
            name: primaryName,
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
            originalPhoneNumber: farmerRemarkSuffix
              ? `${originalPhoneNumber || ""}${originalPhoneNumber ? " | " : ""}${farmerRemarkSuffix}`
              : originalPhoneNumber,
          };

          if (dryRun) {
            farmer = { _id: `dry-run-farmer-${rowIndex + 2}`, ...farmerData };
            results.dryRunActions.push({
              row: rowIndex + 2,
              bookingNo: row["Booking NO."],
              action: "CREATE_FARMER",
              payload: farmerData,
            });
          } else {
            farmer = await Farmer.create(farmerData);
          }
          
          // Add to cache for future lookups
          if (primaryNumber) {
            farmerPhoneMap.set(primaryNumber, farmer);
          }
          if (alternateNumber) {
            farmerPhoneMap.set(alternateNumber, farmer);
          }
        } else {
          // Do not overwrite existing farmer profile fields unless minimal phone normalization required.
          const isLeanObject = !farmer.save || typeof farmer.save !== 'function';
          
          let needsUpdate = false;
          const updateData = {};
          
          if (primaryNumber && !farmer.mobileNumber) {
            updateData.mobileNumber = primaryNumber;
            needsUpdate = true;
          }
          
          if (alternateNumber && !farmer.alternateNumber) {
            updateData.alternateNumber = alternateNumber;
            needsUpdate = true;
          }
          
          if (farmer.isInvalidPhone !== isInvalidPhone) {
            updateData.isInvalidPhone = isInvalidPhone;
            needsUpdate = true;
          }
          
          if (needsUpdate && !dryRun) {
            if (isLeanObject) {
              // Use findByIdAndUpdate for lean objects
              await Farmer.findByIdAndUpdate(farmer._id, updateData);
              // Update the cached farmer object
              farmer.mobileNumber = updateData.mobileNumber || farmer.mobileNumber;
              farmer.alternateNumber = updateData.alternateNumber || farmer.alternateNumber;
              farmer.isInvalidPhone = updateData.isInvalidPhone !== undefined ? updateData.isInvalidPhone : farmer.isInvalidPhone;
            } else {
              // Use save for mongoose documents
              Object.assign(farmer, updateData);
              await farmer.save();
            }
          }
        }

        // Strict employee mapping: Refrence only, substring match on SALES/DEALER users.
        const referenceValue = (row["Refrence"] || "").toString().trim();
        if (!referenceValue) {
          throw new Error(`Missing Refrence for booking ${row["Booking NO."] || "unknown"}`);
        }
        const salesPerson = findMatchingEmployeeByReference(referenceValue, salesPersons);
        if (!salesPerson) {
          throw new Error(`Refrence "${referenceValue}" did not match any SALES/DEALER user`);
        }

        // Get plant and variety
        const plantName = row.normalizedCrop;
        const displayPlantName = row["Crop"];
        const varietyName = row.mappedVarietyName;

        if (!plantName) {
          throw new Error(`Missing plant name for booking no ${row["Booking NO."] || "unknown"}`);
        }

        if (!varietyName) {
          throw new Error(
            `Variety not provided for plant "${displayPlantName}" at row ${rowIndex + 2}`
          );
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

        // Find slot - Expected Del. Date is mandatory
        let slot;
        
        if (!row.slots || row.slots === null || row.slots === '') {
          throw new Error(`Missing Expected Del. Date for booking ${row["Booking NO."] || "unknown"}`);
        } else {
          // Parse delivery date strictly using UTC to prevent timezone shifts
          const deliveryDate = moment.utc(row.slots, "DD-MM-YYYY", true);
          if (!deliveryDate.isValid()) {
            throw new Error(`Invalid Expected Del. Date format: ${row.slots} for booking ${row["Booking NO."] || "unknown"}`);
          } else {
            // Use exact Indian calendar date without +1 day shift.
            const deliveryDateUTC = moment.utc(deliveryDate.format("YYYY-MM-DD")).hour(12).minute(0).second(0).millisecond(0);

            slot = dryRun
              ? { _id: `dry-run-slot-${rowIndex + 2}` }
              : await findDeliverySlot(
                  plant._id,
                  subtype._id,
                  deliveryDateUTC.toDate()
                );
            if (!slot) {
              throw new Error(`No slot found for Expected Del. Date ${row.slots} (${displayPlantName} / ${varietyName})`);
            }
          }
        }

        // Process tray (cavity logic)
        let tray = null;
        if (row["Media"]) {
          let cavityValue = row["Media"];
          let mediaStr = "";
          
          // Handle different Media formats:
          // - "8 Cavity" -> extract 8
          // - "elli" or "elli cavity" -> check aliases first, then default to 10
          // - Just a number -> use directly
          
          if (typeof cavityValue === "string") {
            mediaStr = cavityValue.trim().toLowerCase();
            
            // First, check if the media string matches any tray aliases
            let foundTrayByAlias = null;
            for (const [cavityNum, trayData] of trayMap.entries()) {
              if (trayData.aliases && Array.isArray(trayData.aliases)) {
                const matchingAlias = trayData.aliases.find(alias => 
                  alias.toLowerCase() === mediaStr || mediaStr.includes(alias.toLowerCase())
                );
                if (matchingAlias) {
                  foundTrayByAlias = trayData;
                  break;
                }
              }
            }
            
            if (foundTrayByAlias) {
              tray = foundTrayByAlias;
            } else if (mediaStr === "elli" || mediaStr.includes("elli")) {
              // Fallback: Check for "elli" (10 cavity) if no alias match
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
          
          // Look up tray by cavity number if not found by alias
          if (!tray && typeof cavityValue === "number" && !isNaN(cavityValue)) {
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
        // TC = TEMPORARY_CANCELLED
        // N = ACCEPTED (default)
        let orderStatus = 'ACCEPTED'; // Default
        if (delYNUpper === 'Y') {
          orderStatus = 'COMPLETED';
        } else if (delYNUpper === 'TC') {
          orderStatus = 'TEMPORARY_CANCELLED';
        } else if (delYNUpper === 'N') {
          orderStatus = 'ACCEPTED';
        }

        const finalOrderId = await allocateNextOrderId(Order, {
          reserved: usedOrderIds,
        });
        reserveOrderId(usedOrderIds, finalOrderId);

        // Set delivery date from Expected Del. Date (mandatory)
        let finalDeliveryDate = null;
        if (row.slots) {
          const deliveryDate = moment.utc(row.slots, "DD-MM-YYYY", true);
          if (deliveryDate.isValid()) {
            finalDeliveryDate = moment.utc(deliveryDate.format("YYYY-MM-DD")).hour(12).minute(0).second(0).millisecond(0).toDate();
          } else {
            throw new Error(`Invalid Expected Del. Date format: ${row.slots} for booking ${row["Booking NO."] || "unknown"}`);
          }
        }
        let orderNotes = row["Remark"] || "";
        if (row.legacyBookingRef) {
          orderNotes = `${orderNotes}${orderNotes ? " | " : ""}Legacy booking: ${row.legacyBookingRef}`;
        }
        const orderByValue = (row["Order By"] || row["Order\r\nBy"] || row["Order\nBy"] || "").toString().trim();
        if (orderByValue) {
          orderNotes = `${orderNotes}${orderNotes ? " | " : ""}Order By: ${orderByValue}`;
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
          notes: orderNotes,
          paymentCompleted: balanceAmount <= 0,
          orderPaymentStatus: balanceAmount <= 0 ? "COMPLETED" : "PENDING",
          orderBookingDate: row.date ? moment.utc(moment(row.date, "DD-MM-YYYY").format("YYYY-MM-DD")).hour(12).toDate() : new Date(),
          deliveryDate: finalDeliveryDate, // null for undated orders
          is_excel: true,
        };

        const order = dryRun
          ? { _id: `dry-run-order-${rowIndex + 2}`, orderId: finalOrderId, ...orderData, payment: [] }
          : await Order.create(orderData);

        if (!dryRun) {
          try {
            await ensureFarmerPlantOrderDebit(order, {});
          } catch (ledgerError) {
            console.error(
              `⚠️ Ledger ORDER debit ensure failed for order ${order.orderId}:`,
              ledgerError?.message || ledgerError
            );
          }
        }

        // Add payment if advance exists
        const isAdvanceMatched = readAdvMatched(row);
        if (advanceAmount > 0 && isAdvanceMatched) {
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
          if (row["Advance Date"]) {
            paymentData.remark = `${paymentData.remark}${paymentData.remark ? " | " : ""}Advance Date: ${row["Advance Date"]}`;
          }

          if (dryRun) {
            results.dryRunActions.push({
              row: rowIndex + 2,
              bookingNo: row["Booking NO."],
              action: "ADD_ADVANCE_PAYMENT",
              payload: paymentData,
            });
            order.payment = [paymentData];
          } else {
            sanitizePaymentArrayForOrder([paymentData], order);
            order.payment.push(paymentData);
            await order.save();
            try {
              const latestPayment = order.payment?.[order.payment.length - 1];
              if (latestPayment) {
                await recordFarmerPlantLedgerPaymentTransition(
                  order,
                  latestPayment,
                  "PENDING",
                  "COLLECTED",
                  {}
                );
              }
            } catch (ledgerError) {
              console.error(
                `⚠️ Ledger PAYMENT credit ensure failed for order ${order.orderId}:`,
                ledgerError?.message || ledgerError
              );
            }
          }
        }

        // Fetch slot with plant info to check if sowing is allowed
        let slotInfo = null;
        if (!dryRun) {
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
          slotInfo = await getSlotInfo(slot._id);
        }

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
          dryRun,
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
        
        // Save to ErrorfulOrder model in non-dry-run mode only
        if (!dryRun) {
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

  // Extract all unique plant/subtype combinations from Excel and auto-configure slots
  console.log("🌱 Extracting all plant/subtype combinations for validation...");
  const plantSubtypeMap = new Map();
  
  for (const row of processedData) {
    if (!row.normalizedCrop || !row.mappedVarietyName) continue;
    
    const key = `${row.normalizedCrop}::${row.mappedVarietyName}`;
    if (!plantSubtypeMap.has(key)) {
      plantSubtypeMap.set(key, {
        plantName: row.normalizedCrop,
        subtypeName: row.mappedVarietyName,
      });
    }
  }
  
  console.log(`📋 Found ${plantSubtypeMap.size} unique plant/subtype combinations`);
  
  // Bulk fetch reference data first
  const [salesPersons, plants, trays] = await Promise.all([
    User.find({ name: { $in: Array.from(uniqueSalesPersons) }, role: "SALES" }).lean(),
    PlantCms.find({ name: { $in: Array.from(uniquePlants) } }).lean(),
    Tray.find({}).lean() // Fetch all trays to check aliases
  ]);

  // Build initial plant map
  const plantMap = new Map(plants.map(p => [normalizeName(p.name), p]));
  
  // Auto-configure slots for all plant/subtype combinations (like import does)
  console.log("⚙️  Auto-configuring slots for all plant/subtype combinations...");
  for (const [key, { plantName, subtypeName }] of plantSubtypeMap) {
    try {
      await ensurePlantAndSubtype({
        plantName,
        subtypeName,
        plantMap,
      });
      console.log(`✅ Configured slots for ${plantName} -> ${subtypeName}`);
    } catch (error) {
      console.error(`⚠️  Failed to configure slots for ${plantName} -> ${subtypeName}:`, error.message);
    }
  }
  
  // Refresh plant map after auto-configuration
  const refreshedPlants = await PlantCms.find({ name: { $in: Array.from(uniquePlants) } }).lean();
  refreshedPlants.forEach(p => plantMap.set(normalizeName(p.name), p));

  // Create maps for quick lookup
  const salesPersonMap = new Map(salesPersons.map(sp => [normalizeName(sp.name), sp]));
  
  // Build tray map: key by cavity number, also map by aliases
  const trayMap = new Map();
  trays.forEach(t => {
    // Map by cavity number
    trayMap.set(t.cavity, t);
    // Also map by aliases if they exist
    if (t.aliases && Array.isArray(t.aliases)) {
      t.aliases.forEach(alias => {
        // Store reference to the tray for alias lookups
        const aliasKey = alias.toLowerCase();
        if (!trayMap.has(aliasKey)) {
          trayMap.set(aliasKey, t);
        }
      });
    }
  });

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
      if (!row.slots || row.slots === null || row.slots === '') {
        rowErrors.push(`Missing delivery date. Expected Del. Date is required.`);
      } else {
        const deliveryDate = moment.utc(row.slots, "DD-MM-YYYY");
        if (!deliveryDate.isValid()) {
          rowErrors.push(`Invalid delivery date format: ${row["Expected\r\nDel.\r\nDate"]}`);
        } else if (plant) {
          // Try to find slot for this delivery date (using same logic as import)
          try {
            const deliveryDateUTC = moment.utc(deliveryDate.format("YYYY-MM-DD")).hour(12).minute(0).second(0).millisecond(0);
            const year = deliveryDateUTC.year();
            
            // Refresh plant to get latest data after auto-configuration
            const latestPlant = await PlantCms.findById(plant._id).lean();
            if (!latestPlant) {
              rowErrors.push(`Plant not found after configuration`);
            } else {
              const varietyNameForSlot = row.mappedVarietyName;
              const subtype = findSubtypeByName(latestPlant, varietyNameForSlot);
              if (!subtype) {
                rowErrors.push(`Variety "${row["Variety"]}" not found for ${row["Crop"]} after configuration`);
              } else {
                const plantSlot = await PlantSlot.findOne({
                  plantId: latestPlant._id,
                  year: year,
                  "subtypeSlots.subtypeId": subtype._id,
                });
                
                if (!plantSlot) {
                  rowErrors.push(`No slot configuration found for plant in year ${year}. Please configure slots in CMS.`);
                } else {
                  const subtypeSlot = plantSlot.subtypeSlots.find(
                    (ss) => ss.subtypeId.toString() === subtype._id.toString()
                  );
                  
                  if (!subtypeSlot || !subtypeSlot.slots || subtypeSlot.slots.length === 0) {
                    rowErrors.push(`No slots found for variety "${row["Variety"]}"`);
                  } else {
                    // Check if slot exists for delivery date
                    const deliveryDateStr = deliveryDateUTC.format("YYYY-MM-DD");
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
                      rowErrors.push(`No slot found for delivery date ${deliveryDate.format("DD-MM-YYYY")}. Available slots may not cover this date.`);
                    }
                  }
                }
              }
            }
          } catch (slotError) {
            rowErrors.push(`Slot error: ${slotError.message}`);
          }
        }
      }
      
      // Validate tray/cavity if provided
      if (row["Media"]) {
        let cavityValue = row["Media"];
        let foundTray = null;
        
        if (typeof cavityValue === "string") {
          const mediaStr = cavityValue.trim().toLowerCase();
          
          // Check aliases first
          let foundTrayByAlias = null;
          for (const [key, trayData] of trayMap.entries()) {
            if (typeof key === 'string' && key === mediaStr) {
              foundTrayByAlias = trayData;
              break;
            }
          }
          
          if (foundTrayByAlias) {
            foundTray = foundTrayByAlias;
          } else if (mediaStr === "elli" || mediaStr.includes("elli")) {
            // Fallback: Check for "elli" (10 cavity)
            foundTray = trayMap.get(10);
          } else if (mediaStr.includes("cavity")) {
            // Extract number from "X Cavity" format
            const match = mediaStr.match(/(\d+)\s*cavity/i);
            if (match && match[1]) {
              foundTray = trayMap.get(parseInt(match[1], 10));
            }
          } else {
            // Try to parse as a number directly
            const parsed = parseInt(cavityValue.trim(), 10);
            if (!isNaN(parsed)) {
              foundTray = trayMap.get(parsed);
            }
          }
        } else if (typeof cavityValue === "number") {
          foundTray = trayMap.get(cavityValue);
        }
        
        if (!foundTray) {
          rowErrors.push(`Tray/Cavity "${row["Media"]}" not found. Please add it in CMS.`);
        }
      }

      // If no errors, row is processable
      if (rowErrors.length === 0) {
        results.processableRows++;
      } else {
        // Determine error type for categorization
        let errorType = 'UNKNOWN_ERROR';
        const errorMessages = rowErrors.join('; ').toLowerCase();
        
        if (errorMessages.includes('slot') || errorMessages.includes('no slot')) {
          errorType = 'SLOT_ERROR';
        } else if (errorMessages.includes('plant') || errorMessages.includes('variety')) {
          errorType = 'PLANT_ERROR';
        } else if (errorMessages.includes('sales person') || errorMessages.includes('reference')) {
          errorType = 'SALES_PERSON_ERROR';
        } else if (errorMessages.includes('tray') || errorMessages.includes('cavity')) {
          errorType = 'TRAY_ERROR';
        } else if (errorMessages.includes('date') || errorMessages.includes('delivery')) {
          errorType = 'DATE_ERROR';
        } else if (errorMessages.includes('missing')) {
          errorType = 'MISSING_DATA';
        }
        
        // Add to unprocessed rows with error column
        results.unprocessedRows.push({
          ...row,
          "Error": rowErrors.join("; "),
          "Error Type": errorType
        });
        results.errors.push({
          row: i + 2,
          bookingNo: row["Booking NO."] || "N/A",
          name: row["Name"] || "N/A",
          crop: row["Crop"] || "N/A",
          variety: row["Variety"] || "N/A",
          errorType: errorType,
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

// Helper function to get or create dummy slot for undated orders
async function getOrCreateDummySlot(plantId, subtypeId) {
  try {
    // Use year 2099 for dummy slots (far future, easily identifiable)
    const DUMMY_YEAR = 2099;
    const DUMMY_START_DATE = "01-01-2099";
    const DUMMY_END_DATE = "31-12-2099";
    
    let plantSlot = await PlantSlot.findOne({
      plantId: plantId,
      year: DUMMY_YEAR,
      "subtypeSlots.subtypeId": subtypeId,
    });

    if (!plantSlot) {
      // Create new plant slot document for dummy year
      plantSlot = new PlantSlot({
        plantId: plantId,
        year: DUMMY_YEAR,
        subtypeSlots: [],
      });
    }

    const subtypeSlot = plantSlot.subtypeSlots.find(
      (ss) => ss.subtypeId.toString() === subtypeId.toString()
    );

    if (!subtypeSlot) {
      // Create subtype slot entry
      plantSlot.subtypeSlots.push({
        subtypeId: subtypeId,
        slots: [],
      });
    }

    // Find or create dummy slot
    const dummySlot = (subtypeSlot || plantSlot.subtypeSlots[plantSlot.subtypeSlots.length - 1])
      .slots.find(
        (slot) => slot.startDay === DUMMY_START_DATE && slot.endDay === DUMMY_END_DATE
      );

    if (!dummySlot) {
      // Create dummy slot
      const newDummySlot = {
        startDay: DUMMY_START_DATE,
        endDay: DUMMY_END_DATE,
        month: "January",
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
        isManual: true, // Mark as manual so it's identifiable
      };

      const targetSubtypeSlot = plantSlot.subtypeSlots.find(
        (ss) => ss.subtypeId.toString() === subtypeId.toString()
      );
      
      if (targetSubtypeSlot) {
        targetSubtypeSlot.slots.push(newDummySlot);
      }

      await plantSlot.save();
      
      // Return the newly created slot
      const savedPlantSlot = await PlantSlot.findOne({
        plantId: plantId,
        year: DUMMY_YEAR,
        "subtypeSlots.subtypeId": subtypeId,
      });
      
      const savedSubtypeSlot = savedPlantSlot.subtypeSlots.find(
        (ss) => ss.subtypeId.toString() === subtypeId.toString()
      );
      
      return savedSubtypeSlot.slots.find(
        (slot) => slot.startDay === DUMMY_START_DATE && slot.endDay === DUMMY_END_DATE
      );
    }

    return dummySlot;
  } catch (error) {
    console.error("Error creating dummy slot:", error);
    throw error;
  }
}

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

    let plantSlot = await PlantSlot.findOne({
      plantId: plantId,
      year: year,
      "subtypeSlots.subtypeId": subtypeId,
    });

    // Auto-create slots if they don't exist
    if (!plantSlot) {
      console.log(`🔄 Auto-creating slots for plant ${plantId}, subtype ${subtypeId}, year ${year}`);
      
      // Get plant and subtype info to create slots
      const PlantCms = (await import('../models/plantCms.model.js')).default;
      const plant = await PlantCms.findById(plantId);
      if (!plant) {
        throw new Error(`Plant not found: ${plantId}`);
      }
      
      const subtype = plant.subtypes.find(s => s._id.toString() === subtypeId.toString());
      if (!subtype) {
        throw new Error(`Subtype not found: ${subtypeId}`);
      }
      
      // Use subtype's slot configuration or plant defaults
      const slotDays = subtype.slotDays || plant.slotSize || 7;
      const plantReadyDays = subtype.plantReadyDays || 0;
      
      // Determine slot capacity - use subtype's slotCapacity or default
      const slotCapacity = subtype.slotCapacity || 100000;
      
      // Create slots for this subtype with proper configuration
      await ensureSlotsForSubtype({
        plantId: plantId,
        subtypeId: subtypeId,
        slotSize: slotDays,
        plantReadyDays: plantReadyDays,
      });
      
      // Try to find the slot again
      plantSlot = await PlantSlot.findOne({
        plantId: plantId,
        year: year,
        "subtypeSlots.subtypeId": subtypeId,
      });
      
      if (!plantSlot) {
        // If still not found, try creating with default configuration
        console.log(`⚠️  Slot not found after creation, attempting with default config...`);
        const defaultSlotDays = 7;
        const defaultCapacity = 100000;
        
        await ensureSlotsForSubtype({
          plantId: plantId,
          subtypeId: subtypeId,
          slotSize: defaultSlotDays,
          plantReadyDays: 0,
        });
        
        plantSlot = await PlantSlot.findOne({
          plantId: plantId,
          year: year,
          "subtypeSlots.subtypeId": subtypeId,
        });
        
        if (!plantSlot) {
          throw new Error(`No slot configuration found for plant in year ${year}. Please configure slots for ${plant.name} -> ${subtype.name} in the system.`);
        }
      }
      
      console.log(`✅ Auto-created slots for plant ${plant.name}, subtype ${subtype.name}, year ${year}`);
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
    autoCreatedVarieties: [], // Track auto-created plant varieties
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
      if (person.name) {
        const normalizedName = person.name.toLowerCase().trim();
        salesPersonMap.set(normalizedName, person);
        // Also add with original name (case-sensitive) for exact matches
        salesPersonMap.set(person.name.trim(), person);
      }
    });
    console.log(`📋 Pre-loaded ${allSalesPersons.length} sales persons into cache`);

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

    const usedOrderIds = new Set();

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

        // 2. Legacy booking reference from sheet (not used as numeric orderId)
        let bookingNo = row["Booking NO."];
        if (!bookingNo || bookingNo === "" || bookingNo === 0) {
          const year = moment(bookingDate).format("YYYY");
          const month = moment(bookingDate).format("MM");
          bookingNo = `${year}${month}-import`;
        }
        const legacyBookingRef = String(bookingNo).trim();

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

        let plant = plantMap.get(cropName.toLowerCase());
        if (!plant) {
          throw new Error(`Plant "${cropName}" not found at row ${rowIndex + 2}`);
        }

        // Get fresh plant document from DB to modify if needed
        let plantDoc = await PlantCms.findById(plant._id);
        if (!plantDoc) {
          throw new Error(`Plant "${cropName}" not found in database at row ${rowIndex + 2}`);
        }

        // Try to find subtype with flexible matching (handle G-9 vs G9, etc.)
        let subtype = plantDoc.subtypes.find(
          (st) => {
            const stName = (st.name || "").toLowerCase().trim().replace(/-/g, "");
            const varName = varietyName.toLowerCase().trim().replace(/-/g, "");
            return stName === varName;
          }
        );
        
        // Auto-create variety if not found
        if (!subtype) {
          console.log(`🔄 Auto-creating variety "${varietyName}" for plant "${cropName}"`);
          
          // Get default values from existing subtypes or use sensible defaults
          const existingSubtype = plantDoc.subtypes.length > 0 ? plantDoc.subtypes[0] : null;
          const defaultSlotDays = existingSubtype?.slotDays || plantDoc.slotSize || 5;
          const defaultPlantReadyDays = existingSubtype?.plantReadyDays || 0;
          const defaultRates = existingSubtype?.rates || [0];
          
          // Ensure all required fields have values (use current year for dates if not available)
          const currentYear = moment().year();
          const defaultSlotStartDate = existingSubtype?.slotStartDate || `${currentYear}-01-01`;
          const defaultSlotEndDate = existingSubtype?.slotEndDate || `${currentYear + 1}-12-31`;
          const defaultSlotCapacity = existingSubtype?.slotCapacity || 1000;
          
          // Create new subtype with all required fields
          const newSubtype = {
            name: varietyName,
            description: `Auto-created variety: ${varietyName}`,
            rates: defaultRates,
            buffer: existingSubtype?.buffer || 0,
            plantReadyDays: defaultPlantReadyDays,
            slotDays: defaultSlotDays,
            slotStartDate: defaultSlotStartDate,
            slotEndDate: defaultSlotEndDate,
            slotCapacity: defaultSlotCapacity,
          };
          
          // Add subtype to plant
          plantDoc.subtypes.push(newSubtype);
          
          // Before saving, ensure all existing subtypes have required fields (fix them if missing)
          plantDoc.subtypes = plantDoc.subtypes.map((st) => {
            if (!st.slotDays || !st.slotStartDate || !st.slotEndDate || !st.slotCapacity) {
              return {
                ...st.toObject(),
                slotDays: st.slotDays || defaultSlotDays,
                slotStartDate: st.slotStartDate || defaultSlotStartDate,
                slotEndDate: st.slotEndDate || defaultSlotEndDate,
                slotCapacity: st.slotCapacity || defaultSlotCapacity,
                plantReadyDays: st.plantReadyDays || defaultPlantReadyDays,
                rates: st.rates || defaultRates,
                buffer: st.buffer || 0,
              };
            }
            return st;
          });
          
          await plantDoc.save();
          
          // Update cache with fresh plant data
          const refreshedPlant = await PlantCms.findById(plant._id).lean();
          plantMap.set(cropName.toLowerCase(), refreshedPlant);
          plant = refreshedPlant;
          plantDoc = await PlantCms.findById(plant._id);
          
          // Find the newly created subtype (with flexible matching)
          subtype = plantDoc.subtypes.find(
            (st) => {
              const stName = (st.name || "").toLowerCase().trim().replace(/-/g, "");
              const varName = varietyName.toLowerCase().trim().replace(/-/g, "");
              return stName === varName;
            }
          );
          
          if (!subtype) {
            throw new Error(`Failed to create variety "${varietyName}" for "${cropName}" at row ${rowIndex + 2}`);
          }
          
          // Ensure slots exist for the newly created subtype
          try {
            await ensureSlotsForSubtype({
              plantId: plantDoc._id,
              subtypeId: subtype._id,
              slotSize: defaultSlotDays,
              plantReadyDays: defaultPlantReadyDays,
            });
            console.log(`✅ Created slots for variety "${varietyName}"`);
          } catch (slotError) {
            console.warn(`⚠️  Could not create slots for variety "${varietyName}":`, slotError.message);
            // Continue anyway - slots might exist or be created later
          }
          
          // Track auto-created variety
          results.autoCreatedVarieties.push({
            plantName: cropName,
            varietyName: varietyName,
            message: "Auto-created during import"
          });
          
          console.log(`✅ Auto-created variety "${varietyName}" for plant "${cropName}"`);
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
          
          // Only proceed if we have a valid cavity number
          if (!isNaN(cavityNumber) && cavityNumber > 0) {
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
              } else {
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
          } else {
            console.log(`⚠️  Could not extract valid cavity number from Media: "${cavityValue}" - skipping tray assignment`);
          }
        }

        // 6. Parse delivery dates and determine slot
        let deliveryDate = null;
        let oldDeliveryDate = null;
        let slot = null;
        let slotDate = null;

        // Parse Expected Del. Date (handle both "Expected Del." and "Expected\r\nDel.\r\nDate")
        const expectedDelKey = row["Expected Del."] !== undefined 
          ? "Expected Del." 
          : (row["Expected\r\nDel.\r\nDate"] !== undefined ? "Expected\r\nDel.\r\nDate" : null);
        
        if (expectedDelKey && row[expectedDelKey]) {
          const expectedDelStr = convertDate(row[expectedDelKey]);
          if (expectedDelStr) {
            deliveryDate = moment.utc(expectedDelStr, "DD-MM-YYYY").hour(12).toDate();
          }
        }

        // Parse Old Del. Date (handle both "Old Del. Date" and "Old\r\nDel. Date\r\n(If Changed)")
        const oldDelKey = row["Old Del. Date"] !== undefined 
          ? "Old Del. Date" 
          : (row["Old\r\nDel. Date\r\n(If Changed)"] !== undefined ? "Old\r\nDel. Date\r\n(If Changed)" : null);
        
        if (oldDelKey && row[oldDelKey]) {
          const oldDelStr = convertDate(row[oldDelKey]);
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

        // 7. Parse order status from Del. Y/N (case-sensitive matching)
        // TC = TEMPORARY_CANCELLED
        // N = ACCEPTED
        // Y = COMPLETED
        // C = CANCELLED (or REJECTED)
        let orderStatus = "ACCEPTED"; // Default to ACCEPTED for N
        const delYN = (row["Del. Y/N"] || row["Del.\r\nY/N"] || row["Del.\nY/N"] || "").toString().trim();
        
        // Case-sensitive matching as per requirements
        if (delYN === "Y") {
          orderStatus = "COMPLETED";
        } else if (delYN === "N") {
          orderStatus = "ACCEPTED";
        } else if (delYN === "C") {
          orderStatus = "CANCELLED"; // Can also be REJECTED, using CANCELLED as default
        } else if (delYN === "TC") {
          orderStatus = "TEMPORARY_CANCELLED";
        } else if (delYN === "") {
          // If empty, default to ACCEPTED
          orderStatus = "ACCEPTED";
        }

        // 8. Find or create sales person (Order By)
        let salesPerson = null;
        const orderByName = (row["Order By"] || row["Order\r\nBy"] || row["Order\nBy"] || "").toString().trim();
        
        if (orderByName) {
          // Normalize name for lookup (trim and lowercase)
          const normalizedName = orderByName.toLowerCase().trim();
          
          // First check in cache
          salesPerson = salesPersonMap.get(normalizedName);
          
          if (!salesPerson) {
            // Try to find in database with case-insensitive name matching
            // Search by exact name match first, then case-insensitive
            salesPerson = await User.findOne({
              $and: [
                {
                  $or: [
                    { name: orderByName },
                    { name: { $regex: new RegExp(`^${orderByName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } }
                  ]
                },
                {
                  $or: [{ jobTitle: "SALES" }, { role: "SALES" }, { role: "DEALER" }]
                }
              ]
            });
            
            if (salesPerson) {
              // Add to cache with normalized name
              const foundNormalizedName = (salesPerson.name || "").toLowerCase().trim();
              salesPersonMap.set(foundNormalizedName, salesPerson);
              salesPersonMap.set(normalizedName, salesPerson); // Also add with Excel name
              console.log(`✅ Found existing sales person: ${salesPerson.name} for "${orderByName}"`);
            } else {
              // Create new sales person with dummy number
              const dummyPhone = `9999999${Math.floor(1000 + Math.random() * 9000)}`;
              console.log(`🆕 Creating new sales person: ${orderByName} (${dummyPhone})`);
              salesPerson = await createSalesPerson(orderByName, dummyPhone);
              salesPersonMap.set(normalizedName, salesPerson);
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
        const referenceName = (row["Refrence"] || row["Refrence\r\n"] || row["Refrence\n"] || "").toString().trim();
        
        if (referenceName) {
          // Normalize name for lookup (trim and lowercase)
          const normalizedRefName = referenceName.toLowerCase().trim();
          
          // First check in cache (salesPersonMap is used for both sales and reference users)
          referenceUser = salesPersonMap.get(normalizedRefName);
          
          if (!referenceUser) {
            // Try to find in database with case-insensitive name matching
            referenceUser = await User.findOne({
              $or: [
                { name: referenceName },
                { name: { $regex: new RegExp(`^${referenceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } }
              ]
            });
            
            if (referenceUser) {
              // Add to cache with normalized name
              const foundNormalizedName = (referenceUser.name || "").toLowerCase().trim();
              salesPersonMap.set(foundNormalizedName, referenceUser);
              salesPersonMap.set(normalizedRefName, referenceUser); // Also add with Excel name
              console.log(`✅ Found existing reference user: ${referenceUser.name} for "${referenceName}"`);
            } else {
              // Create new reference user if not found
              console.log(`🔄 Auto-creating reference user: ${referenceName}`);
              referenceUser = await createReferenceUser(referenceName, null);
              salesPersonMap.set(normalizedRefName, referenceUser);
              
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

        const allocatedOrderId = await allocateNextOrderId(Order, {
          reserved: usedOrderIds,
        });
        reserveOrderId(usedOrderIds, allocatedOrderId);

        const legacyNote = legacyBookingRef
          ? `Legacy booking: ${legacyBookingRef}`
          : "";

        const order = new Order({
          orderId: allocatedOrderId,
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
          notes: legacyNote,
          payment: [],
          is_excel: true,
        });

        await order.save();

        // 11. Handle payments
        const totalOrderAmount = numberOfPlants * rate;
        
        // Get advance amount from multiple possible columns (handle line breaks)
        // Priority: "Advance On Booking Receipts" > "Advance Amt." > "Advance\r\nAmt."
        let advanceAmount = 0;
        const advanceOnBookingReceipts = row["Advance On Booking Receipts"] || row["Advance\r\nOn\r\nBooking\r\nReceipts"] || row["Advance\nOn\nBooking\nReceipts"];
        const advanceAmt = row["Advance Amt."] || row["Advance\r\nAmt."] || row["Advance\nAmt."];
        
        if (advanceOnBookingReceipts !== undefined && advanceOnBookingReceipts !== null && advanceOnBookingReceipts !== "") {
          advanceAmount = parseFloat(advanceOnBookingReceipts) || 0;
          console.log(`📊 Found advance amount from "Advance On Booking Receipts": ${advanceAmount} for order ${bookingNo}`);
        } else if (advanceAmt !== undefined && advanceAmt !== null && advanceAmt !== "") {
          advanceAmount = parseFloat(advanceAmt) || 0;
          console.log(`📊 Found advance amount from "Advance Amt.": ${advanceAmount} for order ${bookingNo}`);
        }
        
        const advanceDate = row["Advance On"] 
          ? moment.utc(convertDate(row["Advance On"]), "DD-MM-YYYY").toDate()
          : (row["Advance Date"] 
            ? moment.utc(convertDate(row["Advance Date"]), "DD-MM-YYYY").toDate()
            : bookingDate);
        
        // Check "ADV Y/N" column to determine if payment is collected (not case sensitive)
        // Priority: "ADV Y/N" > "adv match or not"
        let isAdvanceCollected = false;
        
        // First check "ADV Y/N" (not case sensitive - Y or y means collected)
        const advYN = (row["ADV Y/N"] || row["ADV\r\nY/N"] || row["ADV\nY/N"] || "").toString().trim();
        if (advYN !== undefined && advYN !== null && advYN !== "") {
          // Not case sensitive - Y or y means collected
          isAdvanceCollected = advYN.toUpperCase() === "Y";
        } else {
          // Fall back to "adv match or not" if "ADV Y/N" is not available
          const advMatchOrNot = row["adv match or not"] || row["adv\r\nmatch\r\nor\r\nnot"] || row["adv\nmatch\nor\nnot"];
          if (advMatchOrNot !== undefined && advMatchOrNot !== null && advMatchOrNot !== "") {
            const advMatchStr = advMatchOrNot.toString().trim().toUpperCase();
            isAdvanceCollected = advMatchStr === "Y" || advMatchStr === "TRUE" || advMatchStr === "1";
          }
        }
        
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

        // If order is COMPLETED (Del. Y/N = Y), ensure full payment is added
        if (orderStatus === "COMPLETED") {
          // If there's an advance payment, add it first (mark as COLLECTED for completed orders)
          if (advanceAmount > 0) {
            const advancePaymentStatus = "COLLECTED"; // Mark as COLLECTED for completed orders
            const advancePayment = {
              paidAmount: advanceAmount,
              paymentDate: advanceDate,
              paymentStatus: advancePaymentStatus,
              modeOfPayment: modeOfPayment,
              bankName: bankName,
              chequeNumber: (row["CH No."] || "").toString().trim() || null,
              remark: row["Remark"] || null,
              receiptPhoto: [],
              isWalletPayment: false,
              paymentTiming: "advance",
            };
            order.payment.push(advancePayment);
          }
          
          // Calculate remaining balance
          const remainingBalance = totalOrderAmount - advanceAmount;
          
          // If there's a remaining balance, add a payment entry for it
          if (remainingBalance > 0) {
            const balancePayment = {
              paidAmount: remainingBalance,
              paymentDate: deliveryDate || slotDate || bookingDate, // Use delivery date for balance payment
              paymentStatus: "COLLECTED", // Mark as COLLECTED for completed orders
              modeOfPayment: modeOfPayment || "Cash",
              bankName: bankName,
              chequeNumber: null,
              remark: "Balance payment for completed order",
              receiptPhoto: [],
              isWalletPayment: false,
              paymentTiming: "balance",
            };
            order.payment.push(balancePayment);
          }
          
          // If no advance payment exists, add full payment
          if (advanceAmount === 0) {
            const fullPayment = {
              paidAmount: totalOrderAmount,
              paymentDate: deliveryDate || slotDate || bookingDate,
              paymentStatus: "COLLECTED",
              modeOfPayment: modeOfPayment || "Cash",
              bankName: bankName,
              chequeNumber: null,
              remark: "Full payment for completed order",
              receiptPhoto: [],
              isWalletPayment: false,
            };
            sanitizePaymentArrayForOrder([fullPayment], order);
            order.payment.push(fullPayment);
          }
          
          // Update order payment status to COMPLETED
          order.orderPaymentStatus = "COMPLETED";
          order.paymentCompleted = true;
          
          await order.save();
        } else {
          // For non-completed orders, add advance payment if it exists
          if (advanceAmount > 0) {
            // Use "adv match or not" or "ADV Y/N" to determine payment status
            const paymentStatus = isAdvanceCollected ? "COLLECTED" : "PENDING";
            const payment = {
              paidAmount: advanceAmount,
              paymentDate: advanceDate,
              paymentStatus: paymentStatus,
              modeOfPayment: modeOfPayment,
              bankName: bankName,
              chequeNumber: (row["CH No."] || "").toString().trim() || null,
              remark: row["Remark"] || (isAdvanceCollected ? "Advance payment matched" : null),
              receiptPhoto: [],
              isWalletPayment: false,
              paymentTiming: "advance",
            };
            order.payment.push(payment);
            console.log(`💰 Added payment: ${advanceAmount} (Status: ${paymentStatus}, ADV Y/N: ${advYN || "N/A"}, isCollected: ${isAdvanceCollected}) for order ${bookingNo}`);
            await order.save();
          } else {
            // Log if "adv match or not" is Y but no amount found
            if (isAdvanceCollected) {
              console.warn(`⚠️  "adv match or not" is Y but no advance amount found for order ${bookingNo}. Available columns:`, Object.keys(row).filter(k => k.toLowerCase().includes('advance')));
            }
          }
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
    console.log(`   🌱 Auto-created Varieties: ${results.autoCreatedVarieties?.length || 0}`);
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
