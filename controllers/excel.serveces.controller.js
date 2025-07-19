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

// Original Excel import function - simple and reliable
export const importOrdersAndFarmers = async (fileBuffer) => {
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

  // Process each row individually for reliability
  console.log(`📊 Processing ${data.length} rows individually`);

  for (let rowIndex = 0; rowIndex < data.length; rowIndex++) {
    const row = data[rowIndex];
    console.log(`🔄 Processing row ${rowIndex + 1}/${data.length}`);
    
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
        results.summary.totalProcessed++;

        // Convert dates using new column names
        const processedRow = {
        ...row,
        date: convertDate(row["Date"]),
        slots: convertDate(row["Expected\r\nDel.\r\nDate"]),
        "Advance Date": row["Advance\r\nDate"]
          ? convertDate(row["Advance\r\nDate"])
          : null,
      };

      // Check if order already exists
      const orderNumber = parseInt(processedRow["Booking NO."].replace("24-25/B", ""), 10);
      console.log(`🔍 Looking for order with orderId: ${orderNumber} (from booking: ${processedRow["Booking NO."]})`);
      
      let existingOrder = await Order.findOne({
        orderId: orderNumber,
      }).session(session);

      console.log(`📋 Existing order found: ${existingOrder ? 'YES' : 'NO'}`);

      if (existingOrder) {
        // Update orderBookingDate if present in Excel
        if (processedRow.date) {
          existingOrder.orderBookingDate = moment(processedRow.date, "DD-MM-YYYY").toDate();
          await existingOrder.save({ session });
        }
        results.success.push({
          bookingNo: processedRow["Booking NO."],
          updated: true,
          message: "Order booking date updated",
        });
        results.summary.successfulImports++;
        continue;
      }

      const mobileValue = processedRow["Mobile No."];

      // Check for empty, null, undefined, or dummy values
      const isMissingOrDummy =
        !mobileValue ||
        mobileValue === "" ||
        mobileValue === null ||
        mobileValue === undefined ||
        mobileValue === "dummy" ||
        mobileValue === "Dummy" ||
        mobileValue === "DUMMY" ||
        mobileValue === "9999999999" ||
        mobileValue === 9999999999;

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

      // Keep original number as-is, don't use dummy numbers
      const primaryNumber = cleanedNumbers.primaryNumber;
      const alternateNumber = cleanedNumbers.alternateNumber;
      const isInvalidPhone = cleanedNumbers.isInvalid || !primaryNumber;
      const originalPhoneNumber = cleanedNumbers.originalValue;

      // Create/update farmer using new column names
      const farmerData = {
        name: processedRow["Name"],
        mobileNumber: primaryNumber || null, // Keep as null if no valid number
        alternateNumber: alternateNumber || null,
        village: processedRow["Address"], // Using Address instead of Village
        taluka: processedRow["Taluka"],
        district: processedRow["District"],
        state: "Maharashtra",
        talukaName: processedRow["Taluka"],
        districtName: processedRow["District"],
        stateName: "Maharashtra",
        isInvalidPhone: isInvalidPhone, // Mark as invalid if no valid number
        originalPhoneNumber: originalPhoneNumber,
      };

      let farmer = null;
      
      // Try to find farmer by phone number if we have valid numbers
      if (primaryNumber) {
        // Check for duplicate mobile number first
        const existingFarmerWithMobile = await Farmer.findOne({
          mobileNumber: primaryNumber,
        }).session(session);
        
        if (existingFarmerWithMobile) {
          throw new Error(`Mobile number ${primaryNumber} is already registered to farmer: ${existingFarmerWithMobile.name}`);
        }
        
        // Check for duplicate alternate number
        const existingFarmerWithAlternate = await Farmer.findOne({
          alternateNumber: primaryNumber,
        }).session(session);
        
        if (existingFarmerWithAlternate) {
          throw new Error(`Mobile number ${primaryNumber} is already registered as alternate number to farmer: ${existingFarmerWithAlternate.name}`);
        }
        
        // Now search for existing farmer by phone numbers
        farmer = await Farmer.findOne({
          $or: [
            { mobileNumber: primaryNumber },
            { alternateNumber: primaryNumber },
          ],
        }).session(session);
      }
      
      // If not found and we have alternate number, try that
      if (!farmer && alternateNumber) {
        farmer = await Farmer.findOne({
          $or: [
            { mobileNumber: alternateNumber },
            { alternateNumber: alternateNumber },
          ],
        }).session(session);
      }
      
      // If still not found and we have no valid phone numbers, try to find by name and location
      if (!farmer && (!primaryNumber || isInvalidPhone)) {
        farmer = await Farmer.findOne({
          name: processedRow["Name"],
          village: processedRow["Address"],
          taluka: processedRow["Taluka"],
          district: processedRow["District"]
        }).session(session);
      }

      if (!farmer) {
        // For farmers with invalid phone numbers, we need to handle the unique constraint
        if (isInvalidPhone || !primaryNumber) {
          // Create farmer with null mobileNumber and mark as invalid
          const farmerWithInvalidPhone = {
            ...farmerData,
            mobileNumber: null,
            isInvalidPhone: true
          };
          farmer = await Farmer.create([farmerWithInvalidPhone], { session });
          farmer = farmer[0];
        } else {
          // Create farmer with valid phone number
          farmer = await Farmer.create([farmerData], { session });
          farmer = farmer[0];
        }
      } else {
        // If farmer exists, update phone numbers if we have valid ones
        let needsUpdate = false;
        
        if (primaryNumber && !farmer.mobileNumber) {
          farmer.mobileNumber = primaryNumber;
          needsUpdate = true;
        }
        
        if (alternateNumber && !farmer.alternateNumber) {
          farmer.alternateNumber = alternateNumber;
          needsUpdate = true;
        }
        
        // Update invalid phone status if needed
        if (farmer.isInvalidPhone !== isInvalidPhone) {
          farmer.isInvalidPhone = isInvalidPhone;
          needsUpdate = true;
        }
        
        if (needsUpdate) {
          await farmer.save({ session });
        }
      }

      // Get sales person using new column name
      const salesPerson = await User.findOne({
        name: processedRow["Refrence"],
      }).session(session);
      if (!salesPerson) {
        throw new Error(
          `Sales person "${processedRow["Refrence"]}" not found`
        );
      }

      // Find plant and variety using new column names
      const plant = await PlantCms.findOne({
        name: processedRow["Crop"],
      }).session(session);
      if (!plant) {
        throw new Error(`Plant type "${processedRow["Crop"]}" not found`);
      }

      const subtype = plant.subtypes.find(
        (st) => st.name === processedRow["Variety"]
      );
      if (!subtype) {
        throw new Error(
          `Variety "${processedRow["Variety"]}" not found for ${processedRow["Crop"]}`
        );
      }

      // Find slot
      const deliveryDate = moment(processedRow.slots, "DD-MM-YYYY");
      if (!deliveryDate.isValid()) {
        throw new Error(`Invalid delivery date format: ${processedRow.slots}`);
      }

      const slot = await findDeliverySlot(
        plant._id,
        subtype._id,
        deliveryDate.toDate(),
        session
      );

      // Calculate amounts using new column names
      const totalAmount =
        Number(processedRow["Plant Qty."]) * Number(processedRow["Rate"]);
      const advanceAmount = Number(processedRow["Advance\r\nAmt."]) || 0;
      const balanceAmount = totalAmount - advanceAmount;

      let cavityValue = processedRow["Media"];
      // Try to find the matching tray by cavity number
      let tray = null;
      if (cavityValue) {
        // Special handling for "Elli" - treat as "10 cavity"
        if (typeof cavityValue === "string" && cavityValue.trim().toLowerCase() === "elli") {
          cavityValue = 10;
          console.log(`🔄 Converting "Elli" to cavity value: ${cavityValue}`);
        } else if (typeof cavityValue === "string") {
          cavityValue = parseInt(cavityValue.trim(), 10);
        }

        // Find the tray with matching cavity number
        tray = await Tray.findOne({ cavity: cavityValue }).session(session);

        if (!tray) {
          console.warn(`Warning: Tray with cavity ${cavityValue} not found`);
          // We'll set cavity to null instead of failing the import
        }
      }

      // Create order using new column names
      // Always set orderStatus to 'ACCEPTED' for Excel uploads, ignore any value from Excel
      const orderData = {
        orderId: orderNumber,
        farmer: farmer._id,
        salesPerson: salesPerson._id,
        numberOfPlants: processedRow["Plant Qty."],
        rate: processedRow["Rate"],
        plantName: plant._id,
        plantSubtype: subtype._id,
        bookingSlot: slot._id, // This should be the slot ObjectId, not an array
        cavity: tray ? tray._id : null,
        orderStatus: 'ACCEPTED', // <-- Always set to ACCEPTED for Excel uploads
        notes: processedRow["Remark"] || "",
        paymentCompleted: balanceAmount <= 0,
        orderPaymentStatus: balanceAmount <= 0 ? "COMPLETED" : "PENDING",
        orderBookingDate: processedRow.date
          ? moment(processedRow.date, "DD-MM-YYYY").toDate()
          : new Date(),
      };

      // Log the slot details for debugging
      console.log(`📋 Creating order ${orderNumber} with slot ID: ${slot._id}`);
      console.log(`📅 Slot period: ${slot.startDay} to ${slot.endDay}`);

      const order = await Order.create([orderData], { session });

      // Add payment if advance exists using new column names
      if (advanceAmount > 0) {
        const paymentData = {
          paidAmount: advanceAmount,
          paymentStatus: "COLLECTED", // Always collected for Excel uploads
          paymentDate: processedRow["Advance Date"]
            ? moment(processedRow["Advance Date"], "DD-MM-YYYY").toDate()
            : new Date(),
          bankName: processedRow["Bank"] || "",
          modeOfPayment: processedRow["Ad. Amt. Mode"] || "CASH",
          remark: processedRow["Remark"] || "",
        };

        if (processedRow["CH No."]) {
          paymentData.remark = `${paymentData.remark} CH.No: ${processedRow["CH No."]}`;
        }

        order[0].payment.push(paymentData);
        await order[0].save({ session });
      }

      // Update slot capacity and add order reference in a single operation to avoid write conflicts
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

      // Get updated slot information
      const slotInfo = await getSlotInfo(slot._id);

      results.success.push({
        bookingNo: processedRow["Booking NO."],
        farmerName: farmer.name,
        orderId: order[0].orderId,
        amount: totalAmount,
        advancePaid: advanceAmount,
        balance: balanceAmount,
        slotInfo: slotInfo,
        phoneStatus: isInvalidPhone ? "Invalid/Missing Phone" : "Valid Phone",
        overflowWarning:
          slotInfo && slotInfo.isOverflow
            ? `Slot is in overflow state. Available plants: ${slotInfo.availablePlants}`
            : null,
      });

      // Track overflow slots
      if (slotInfo && slotInfo.isOverflow) {
        results.summary.overflowSlots++;
      }
      
      // Track invalid phone numbers
      if (isInvalidPhone) {
        results.summary.invalidPhoneNumbers++;
      }

      results.summary.successfulImports++;
      
      // Commit the transaction for this row
      await session.commitTransaction();
      console.log(`✅ Row ${rowIndex + 1} completed successfully`);
      
    } catch (error) {
      await session.abortTransaction();
      console.error(`❌ Error processing row ${rowIndex + 1}:`, error);
      
      results.errors.push({
        bookingNo: row["Booking NO."] || "Unknown",
        error: error.message,
      });
      results.summary.failedImports++;
    } finally {
      session.endSession();
    }
  } // End of row loop

  return results;
};

async function findDeliverySlot(plantId, subtypeId, deliveryDate, session) {
  try {
    // Ensure deliveryDate is a moment object
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
        `No suitable slot found for delivery date ${deliveryMoment.format(
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
