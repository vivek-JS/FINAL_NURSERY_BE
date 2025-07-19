// services/excel.service.js
import mongoose from "mongoose";
import XLSX from "xlsx";
import moment from "moment";
import Farmer from "../models/farmer.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import User from "../models/user.model.js";
import Order from "../models/order.model.js";
import { updateSlot } from "./factory.controller.js";
import Tray from "../models/tray.model.js";

// Function to parse Excel date serial number
function parseExcelDate(serialNumber) {
  const epoch = new Date(1899, 11, 30);
  const offsetDays = serialNumber;
  const offsetMilliseconds = offsetDays * 24 * 60 * 60 * 1000;
  const date = new Date(epoch.getTime() + offsetMilliseconds);
  return date;
}

// Function to check if a value is an Excel date serial number
function isExcelDateSerial(value) {
  return typeof value === "number" && value > 1000 && value < 100000;
}

// Function to format date for display
function formatDate(date) {
  return moment(date).format("DD-MM-YYYY");
}

// Function to handle date conversion
function convertDate(value) {
  if (!value) return null;

  if (isExcelDateSerial(Number(value))) {
    return formatDate(parseExcelDate(Number(value)));
  }

  const date = moment(value, ["DD-MM-YYYY", "MM/DD/YYYY", "YYYY-MM-DD"]);

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
  });

  console.log("Sample data:", data[0]);

  // Updated required columns based on new structure
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

  // Check required columns
  const firstRow = data[0];
  const missingColumns = requiredColumns.filter((col) => !(col in firstRow));
  if (missingColumns.length > 0) {
    validationResults.isValid = false;
    validationResults.errors.push(
      `Missing required columns: ${missingColumns.join(", ")}`
    );
  }

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

// Optimized Excel import with batch processing and caching
export const importOrdersAndFarmers = async (fileBuffer) => {
  console.log("🚀 Starting optimized Excel import...");
  const startTime = Date.now();

  const workbook = XLSX.read(fileBuffer, {
    type: "buffer",
    cellDates: true,
    raw: true,
  });

  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(worksheet, {
    raw: true,
    dateNF: "DD-MM-YYYY",
  });

  const results = {
    success: [],
    errors: [],
    summary: {
      totalProcessed: 0,
      successfulImports: 0,
      failedImports: 0,
      overflowSlots: 0,
      invalidPhoneNumbers: 0,
    },
  };

  console.log(`📊 Processing ${data.length} rows with optimized batch processing`);

  // Pre-process all data and build caches
  const processedData = [];
  const uniqueSalesPersons = new Set();
  const uniquePlants = new Set();
  const uniqueVarieties = new Set();
  const uniqueTrays = new Set();
  const uniqueOrderIds = new Set();
  const uniquePhoneNumbers = new Set();

  // First pass: collect all unique values and pre-process data
  console.log("🔄 Pre-processing data and building caches...");
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const orderNumber = parseInt(row["Booking NO."].replace("24-25/B", ""), 10);
    
    processedData.push({
      ...row,
      orderNumber,
      date: convertDate(row["Date"]),
      slots: convertDate(row["Expected\r\nDel.\r\nDate"]),
      "Advance Date": row["Advance\r\nDate"] ? convertDate(row["Advance\r\nDate"]) : null,
    });

    uniqueOrderIds.add(orderNumber);
    uniqueSalesPersons.add(row["Refrence"]);
    uniquePlants.add(row["Crop"]);
    uniqueVarieties.add(row["Variety"]);
    
    if (row["Media"]) {
      uniqueTrays.add(row["Media"]);
    }

    // Collect valid phone numbers for uniqueness check
    const mobileValue = row["Mobile No."];
    if (mobileValue && mobileValue !== "9999999999" && mobileValue !== 9999999999) {
      const cleanedNumbers = cleanAndValidateMobileNumber(mobileValue);
      if (cleanedNumbers.primaryNumber) {
        uniquePhoneNumbers.add(cleanedNumbers.primaryNumber);
      }
      if (cleanedNumbers.alternateNumber) {
        uniquePhoneNumbers.add(cleanedNumbers.alternateNumber);
      }
    }
  }

  // Bulk fetch all required data in parallel
  console.log("📥 Bulk fetching reference data...");
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
        { mobileNumber: { $in: Array.from(uniquePhoneNumbers) } },
        { alternateNumber: { $in: Array.from(uniquePhoneNumbers) } }
      ]
    }).lean(),
    User.find({ name: { $in: Array.from(uniqueSalesPersons) } }).lean(),
    PlantCms.find({ name: { $in: Array.from(uniquePlants) } }).lean(),
    Tray.find({ cavity: { $in: Array.from(uniqueTrays).map(t => 
      typeof t === "string" && t.trim().toLowerCase() === "elli" ? 10 : parseInt(t, 10)
    )} }).lean()
  ]);

  // Build lookup maps for O(1) access
  const orderMap = new Map(existingOrders.map(o => [o.orderId, o]));
  const farmerPhoneMap = new Map();
  const salesPersonMap = new Map(salesPersons.map(s => [s.name, s]));
  const plantMap = new Map(plants.map(p => [p.name, p]));
  const trayMap = new Map(trays.map(t => [t.cavity, t]));

  // Build farmer phone lookup
  existingFarmers.forEach(farmer => {
    if (farmer.mobileNumber) {
      farmerPhoneMap.set(farmer.mobileNumber, farmer);
    }
    if (farmer.alternateNumber) {
      farmerPhoneMap.set(farmer.alternateNumber, farmer);
    }
  });

  // Process in batches for better performance
  const BATCH_SIZE = 50;
  const batches = [];
  for (let i = 0; i < processedData.length; i += BATCH_SIZE) {
    batches.push(processedData.slice(i, i + BATCH_SIZE));
  }

  console.log(`📦 Processing ${batches.length} batches of ${BATCH_SIZE} rows each`);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    console.log(`🔄 Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} rows)`);
    
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
      const batchResults = await processBatch(
        batch, 
        orderMap, 
        farmerPhoneMap, 
        salesPersonMap, 
        plantMap, 
        trayMap, 
        session
      );
      
      // Merge batch results
      results.success.push(...batchResults.success);
      results.errors.push(...batchResults.errors);
      results.summary.successfulImports += batchResults.summary.successfulImports;
      results.summary.failedImports += batchResults.summary.failedImports;
      results.summary.overflowSlots += batchResults.summary.overflowSlots;
      results.summary.invalidPhoneNumbers += batchResults.summary.invalidPhoneNumbers;
      results.summary.totalProcessed += batchResults.summary.totalProcessed;
      
      await session.commitTransaction();
      console.log(`✅ Batch ${batchIndex + 1} completed successfully`);
      
    } catch (error) {
      await session.abortTransaction();
      console.error(`❌ Error processing batch ${batchIndex + 1}:`, error);
      
      // Add all rows in this batch as errors
      batch.forEach(row => {
        results.errors.push({
          bookingNo: row["Booking NO."] || "Unknown",
          error: error.message,
        });
        results.summary.failedImports++;
        results.summary.totalProcessed++;
      });
    } finally {
      session.endSession();
    }
  }

  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;
  console.log(`🎉 Excel import completed in ${duration.toFixed(2)} seconds`);
  console.log(`📊 Summary: ${results.summary.successfulImports} successful, ${results.summary.failedImports} failed`);

  return results;
};

// Process a batch of rows efficiently
async function processBatch(batch, orderMap, farmerPhoneMap, salesPersonMap, plantMap, trayMap, session) {
  const batchResults = {
    success: [],
    errors: [],
    summary: {
      totalProcessed: 0,
      successfulImports: 0,
      failedImports: 0,
      overflowSlots: 0,
      invalidPhoneNumbers: 0,
    },
  };

  // Pre-fetch all required slots for this batch
  const slotQueries = batch.map(row => {
    const deliveryDate = moment(row.slots, "DD-MM-YYYY");
    const year = deliveryDate.year();
    const month = deliveryDate.format("MMMM");
    
    return {
      year,
      month,
      deliveryDate: deliveryDate.toDate(),
      plantName: row["Crop"],
      variety: row["Variety"]
    };
  });

  // Bulk fetch slots
  const slotPromises = slotQueries.map(query => findDeliverySlotOptimized(query, session));
  const slots = await Promise.all(slotPromises);

  // Process each row in the batch
  for (let i = 0; i < batch.length; i++) {
    const row = batch[i];
    const slot = slots[i];
    
    try {
      batchResults.summary.totalProcessed++;

      // Check if order already exists
      if (orderMap.has(row.orderNumber)) {
        const existingOrder = orderMap.get(row.orderNumber);
        if (row.date) {
          await Order.updateOne(
            { _id: existingOrder._id },
            { orderBookingDate: moment(row.date, "DD-MM-YYYY").toDate() },
            { session }
          );
        }
        
        batchResults.success.push({
          bookingNo: row["Booking NO."],
          updated: true,
          message: "Order booking date updated",
        });
        batchResults.summary.successfulImports++;
        continue;
      }

      // Process farmer data
      const farmerResult = await processFarmerData(row, farmerPhoneMap, session);
      if (farmerResult.error) {
        throw new Error(farmerResult.error);
      }

      // Validate sales person
      const salesPerson = salesPersonMap.get(row["Refrence"]);
      if (!salesPerson) {
        throw new Error(`Sales person "${row["Refrence"]}" not found`);
      }

      // Validate plant and variety
      const plant = plantMap.get(row["Crop"]);
      if (!plant) {
        throw new Error(`Plant type "${row["Crop"]}" not found`);
      }

      const subtype = plant.subtypes.find(st => st.name === row["Variety"]);
      if (!subtype) {
        throw new Error(`Variety "${row["Variety"]}" not found for ${row["Crop"]}`);
      }

      // Validate slot
      if (!slot) {
        throw new Error(`No suitable slot found for delivery date ${row.slots}`);
      }

      // Process tray
      let tray = null;
      if (row["Media"]) {
        let cavityValue = row["Media"];
        if (typeof cavityValue === "string" && cavityValue.trim().toLowerCase() === "elli") {
          cavityValue = 10;
        } else if (typeof cavityValue === "string") {
          cavityValue = parseInt(cavityValue.trim(), 10);
        }
        tray = trayMap.get(cavityValue);
      }

      // Create order
      const totalAmount = Number(row["Plant Qty."]) * Number(row["Rate"]);
      const advanceAmount = Number(row["Advance\r\nAmt."]) || 0;
      const balanceAmount = totalAmount - advanceAmount;

      const orderData = {
        orderId: row.orderNumber,
        farmer: farmerResult.farmer._id,
        salesPerson: salesPerson._id,
        numberOfPlants: row["Plant Qty."],
        rate: row["Rate"],
        plantName: plant._id,
        plantSubtype: subtype._id,
        bookingSlot: slot._id,
        cavity: tray ? tray._id : null,
        orderStatus: 'ACCEPTED',
        notes: row["Remark"] || "",
        paymentCompleted: balanceAmount <= 0,
        orderPaymentStatus: balanceAmount <= 0 ? "COMPLETED" : "PENDING",
        orderBookingDate: row.date ? moment(row.date, "DD-MM-YYYY").toDate() : new Date(),
      };

      const order = await Order.create([orderData], { session });

      // Add payment if advance exists
      if (advanceAmount > 0) {
        const paymentData = {
          paidAmount: advanceAmount,
          paymentStatus: "COLLECTED",
          paymentDate: row["Advance Date"] ? moment(row["Advance Date"], "DD-MM-YYYY").toDate() : new Date(),
          bankName: row["Bank"] || "",
          modeOfPayment: row["Ad. Amt. Mode"] || "CASH",
          remark: row["Remark"] || "",
        };

        if (row["CH No."]) {
          paymentData.remark = `${paymentData.remark} CH.No: ${row["CH No."]}`;
        }

        order[0].payment.push(paymentData);
        await order[0].save({ session });
      }

      // Update slot capacity
      await PlantSlot.updateOne(
        { "subtypeSlots.slots._id": slot._id },
        { 
          $push: { 
            "subtypeSlots.$[subtypeSlot].slots.$[slot].orders": order[0]._id 
          },
          $inc: {
            "subtypeSlots.$[subtypeSlot].slots.$[slot].totalBookedPlants": orderData.numberOfPlants
          }
        },
        {
          arrayFilters: [
            { "subtypeSlot.slots._id": slot._id },
            { "slot._id": slot._id }
          ],
          session: session
        }
      );

      // Get slot info for overflow check
      const slotInfo = await getSlotInfo(slot._id);

      batchResults.success.push({
        bookingNo: row["Booking NO."],
        farmerName: farmerResult.farmer.name,
        orderId: order[0].orderId,
        amount: totalAmount,
        advancePaid: advanceAmount,
        balance: balanceAmount,
        slotInfo: slotInfo,
        phoneStatus: farmerResult.isInvalidPhone ? "Invalid/Missing Phone" : "Valid Phone",
        overflowWarning: slotInfo && slotInfo.isOverflow
          ? `Slot is in overflow state. Available plants: ${slotInfo.availablePlants}`
          : null,
      });

      if (slotInfo && slotInfo.isOverflow) {
        batchResults.summary.overflowSlots++;
      }
      
      if (farmerResult.isInvalidPhone) {
        batchResults.summary.invalidPhoneNumbers++;
      }

      batchResults.summary.successfulImports++;
      
    } catch (error) {
      console.error(`❌ Error processing row:`, error);
      batchResults.errors.push({
        bookingNo: row["Booking NO."] || "Unknown",
        error: error.message,
      });
      batchResults.summary.failedImports++;
    }
  }

  return batchResults;
}

// Process farmer data efficiently
async function processFarmerData(row, farmerPhoneMap, session) {
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
    cleanedNumbers = cleanAndValidateMobileNumber(mobileValue);
  }

  const primaryNumber = cleanedNumbers.primaryNumber;
  const alternateNumber = cleanedNumbers.alternateNumber;
  const isInvalidPhone = cleanedNumbers.isInvalid || !primaryNumber;
  const originalPhoneNumber = cleanedNumbers.originalValue;

  // Check for existing farmer by phone numbers
  let farmer = null;
  if (primaryNumber && farmerPhoneMap.has(primaryNumber)) {
    farmer = farmerPhoneMap.get(primaryNumber);
  } else if (alternateNumber && farmerPhoneMap.has(alternateNumber)) {
    farmer = farmerPhoneMap.get(alternateNumber);
  }

  // If not found by phone, try to find by name and location
  if (!farmer && (!primaryNumber || isInvalidPhone)) {
    farmer = await Farmer.findOne({
      name: row["Name"],
      village: row["Address"],
      taluka: row["Taluka"],
      district: row["District"]
    }).session(session);
  }

  if (!farmer) {
    // Create new farmer
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

    farmer = await Farmer.create([farmerData], { session });
    farmer = farmer[0];
  } else {
    // Update existing farmer if needed
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
      await farmer.save({ session });
    }
  }

  return { farmer, isInvalidPhone };
}

// Optimized slot finding with caching
async function findDeliverySlotOptimized(query, session) {
  try {
    const deliveryMoment = moment(query.deliveryDate);
    if (!deliveryMoment.isValid()) {
      throw new Error(`Invalid delivery date: ${query.deliveryDate}`);
    }

    const year = deliveryMoment.year();
    const month = deliveryMoment.format("MMMM");

    const plantSlot = await PlantSlot.findOne({
      plantId: query.plantName,
      year: year,
    }).session(session);

    if (!plantSlot) {
      throw new Error(`No slot configuration found for plant in year ${year}`);
    }

    const subtypeSlot = plantSlot.subtypeSlots.find(
      (ss) => ss.subtypeId.toString() === query.variety.toString()
    );

    if (!subtypeSlot) {
      throw new Error(`No slots found for variety ${query.variety}`);
    }

    const targetSlot = subtypeSlot.slots.find((slot) => {
      const startMoment = moment(slot.startDay, "DD-MM-YYYY");
      const endMoment = moment(slot.endDay, "DD-MM-YYYY");

      return (
        deliveryMoment.isSameOrAfter(startMoment, "day") &&
        deliveryMoment.isSameOrBefore(endMoment, "day")
      );
    });

    if (!targetSlot) {
      throw new Error(
        `No suitable slot found for delivery date ${deliveryMoment.format("DD-MM-YYYY")} in month ${month}`
      );
    }

    return targetSlot;
  } catch (error) {
    console.error("Error in findDeliverySlotOptimized:", error);
    throw error;
  }
}

// Legacy function for backward compatibility
async function findDeliverySlot(plantId, subtypeId, deliveryDate, session) {
  try {
    const deliveryMoment = moment(deliveryDate);
    if (!deliveryMoment.isValid()) {
      throw new Error(`Invalid delivery date: ${deliveryDate}`);
    }

    const year = deliveryMoment.year();
    const month = deliveryMoment.format("MMMM");

    console.log("Searching for slot with:", {
      year,
      month,
      deliveryDate: deliveryMoment.format("DD-MM-YYYY"),
      plantId,
      subtypeId,
    });

    const plantSlot = await PlantSlot.findOne({
      plantId: plantId,
      year: year,
      "subtypeSlots.subtypeId": subtypeId,
    }).session(session);

    if (!plantSlot) {
      throw new Error(`No slot configuration found for plant in year ${year}`);
    }

    const subtypeSlot = plantSlot.subtypeSlots.find(
      (ss) => ss.subtypeId.toString() === subtypeId.toString()
    );

    if (!subtypeSlot) {
      throw new Error(`No slots found for subtype ${subtypeId}`);
    }

    const targetSlot = subtypeSlot.slots.find((slot) => {
      const startMoment = moment(slot.startDay, "DD-MM-YYYY");
      const endMoment = moment(slot.endDay, "DD-MM-YYYY");

      return (
        deliveryMoment.isSameOrAfter(startMoment, "day") &&
        deliveryMoment.isSameOrBefore(endMoment, "day")
      );
    });

    if (!targetSlot) {
      throw new Error(
        `No suitable slot found for delivery date ${deliveryMoment.format("DD-MM-YYYY")} in month ${month}`
      );
    }

    return targetSlot;
  } catch (error) {
    console.error("Error in findDeliverySlot:", error);
    throw error;
  }
}
