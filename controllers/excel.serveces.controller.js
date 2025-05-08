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

export const validateExcelStructure = (buffer) => {
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

  const requiredColumns = [
    "date",
    "Booking NO.",
    "name",
    "mobileNumber",
    "village",
    "talukaName",
    "districtName",
    "Advance",
    "plantName",
    "plantSubtype",
    "Media",
    "numberPlants",
    "Rate",
    "slots",
    "orderBy",
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
    const rowErrors = [];

    // Validate dates
    const dateFields = ["date", "slots", "Advance Date"];
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
    if (!row.mobileNumber) {
      rowErrors.push("Mobile number is required");
    } else {
      // Clean up and check mobile number format
      const mobileNumbers = row.mobileNumber
        .toString()
        .split(/[,\/\s]+/)
        .map((num) => num.replace(/\s+/g, ""));
      console.log(mobileNumbers);
      if (
        mobileNumbers.length === 0 ||
        !mobileNumbers[0] ||
        !/^\d{10}$/.test(mobileNumbers[0])
      ) {
        rowErrors.push("Primary mobile number should be 10 digits");
      }

      if (mobileNumbers.length > 1 && !/^\d{10}$/.test(mobileNumbers[1])) {
        rowErrors.push("Secondary mobile number should be 10 digits");
      }
    }

    // Validate quantities
    if (
      !row.numberPlants ||
      isNaN(row.numberPlants) ||
      Number(row.numberPlants) <= 0
    ) {
      rowErrors.push("Invalid plant quantity");
    }

    // Validate rate
    if (!row.Rate || isNaN(row.Rate) || Number(row.Rate) <= 0) {
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

// services/excel.service.js

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
    },
  };

  // Process each row in its own transaction
  for (const row of data) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      results.summary.totalProcessed++;

      // Convert dates
      const processedRow = {
        ...row,
        date: convertDate(row.date),
        slots: convertDate(row.slots),
        "Advance Date": row["Advance Date"]
          ? convertDate(row["Advance Date"])
          : null,
      };

      // Check if order already exists
      const orderNumber = processedRow["Booking NO."].replace("24-25/B", "");
      const existingOrder = await Order.findOne({
        orderId: orderNumber,
      }).session(session);

      if (existingOrder) {
        throw new Error(
          `Order with booking number ${processedRow["Booking NO."]} already exists`
        );
      }
      const mobileString = processedRow.mobileNumber
        ? processedRow.mobileNumber.toString()
        : "";
      const mobileNumbers = mobileString
        .split(/[,\/\s]+/)
        .map((num) => num.replace(/\s+/g, ""));

      const primaryNumber = mobileNumbers[0]
        ? parseInt(mobileNumbers[0], 10)
        : null;
      const alternateNumber =
        mobileNumbers.length > 1 ? parseInt(mobileNumbers[1], 10) : null;

      if (!primaryNumber) {
        throw new Error("Valid primary mobile number is required");
      }

      // Create/update farmer
      const farmerData = {
        name: processedRow.name,
        mobileNumber: primaryNumber, // Use the cleaned primaryNumber
        alternateNumber: alternateNumber,
        village: processedRow.village,
        taluka: processedRow.talukaName,
        district: processedRow.districtName,
        state: "Maharashtra",
        talukaName: processedRow.talukaName,
        districtName: processedRow.districtName,
        stateName: "Maharashtra",
      };
      let farmer = await Farmer.findOne({
        $or: [
          { mobileNumber: primaryNumber },
          { alternateNumber: primaryNumber },
        ],
      }).session(session);
   
      if (!farmer && alternateNumber) {
        farmer = await Farmer.findOne({
          $or: [
            { mobileNumber: alternateNumber },
            { alternateNumber: alternateNumber },
          ],
        }).session(session);
      }
      if (!farmer) {
        farmer = await Farmer.create([farmerData], { session });
        farmer = farmer[0];
      } else {
        // If farmer exists but doesn't have alternate number and we have one now, update it
        if (alternateNumber && !farmer.alternateNumber) {
          farmer.alternateNumber = alternateNumber;
          await farmer.save({ session });
        }
      }
      // Get sales person
      const salesPerson = await User.findOne({
        name: processedRow.orderBy,
      }).session(session);
      if (!salesPerson) {
        throw new Error(`Sales person "${processedRow.orderBy}" not found`);
      }

      // Find plant and variety
      const plant = await PlantCms.findOne({
        name: processedRow.plantName,
      }).session(session);
      if (!plant) {
        throw new Error(`Plant type "${processedRow.plantName}" not found`);
      }

      const subtype = plant.subtypes.find(
        (st) => st.name === processedRow.plantSubtype
      );
      if (!subtype) {
        throw new Error(
          `Variety "${processedRow.plantSubtype}" not found for ${processedRow.plantName}`
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

      // Calculate amounts
      const totalAmount =
        Number(processedRow.numberPlants) * Number(processedRow.Rate);
      const advanceAmount = Number(processedRow.Advance) || 0;
      const balanceAmount = totalAmount - advanceAmount;
      let cavityValue = processedRow.Media;
      // Try to find the matching tray by cavity number
      let tray = null;
      if (cavityValue) {
        // Convert to number if it's a string with a number
        if (typeof cavityValue === 'string') {
          cavityValue = parseInt(cavityValue.trim(), 10);
        }
        
        // Find the tray with matching cavity number
        tray = await Tray.findOne({ cavity: cavityValue }).session(session);
        
        if (!tray) {
          console.warn(`Warning: Tray with cavity ${cavityValue} not found`);
          // We'll set cavity to null instead of failing the import
        }
      }
      // Create order
      const orderData = {
        orderId: orderNumber,
        farmer: farmer._id,
        salesPerson: salesPerson._id,
        numberOfPlants: processedRow.numberPlants,
        rate: processedRow.Rate,
        plantName: plant._id,
        plantSubtype: subtype._id,
        bookingSlot: slot._id,
        cavity: tray ? tray._id : null, // Use the tray ID if found, otherwise null
        orderStatus: processedRow["Del. Y/N"] === "Y" ? "COMPLETED" : "PENDING",
        notes: processedRow.Remark || "",
        paymentCompleted: balanceAmount <= 0,
        orderPaymentStatus: balanceAmount <= 0 ? "COMPLETED" : "PENDING",
      };

      const order = await Order.create([orderData], { session });

      // Add payment if advance exists
      if (advanceAmount > 0) {
        const paymentData = {
          paidAmount: advanceAmount,
          paymentStatus: "COLLECTED",
          paymentDate: processedRow["Advance Date"]
            ? moment(processedRow["Advance Date"], "DD-MM-YYYY").toDate()
            : new Date(),
          bankName: processedRow.Bank || "",
          modeOfPayment: processedRow.mode || "CASH",
          remark: processedRow.Remark || "",
        };

        if (processedRow["CH No."]) {
          paymentData.remark = `${paymentData.remark} CH.No: ${processedRow["CH No."]}`;
        }

        order[0].payment.push(paymentData);
        await order[0].save({ session });
      }

      // Update slot capacity
      await updateSlot(slot._id, orderData.numberOfPlants, "subtract");

      // Commit the transaction
      await session.commitTransaction();

      results.success.push({
        bookingNo: processedRow["Booking NO."],
        farmerName: farmer.name,
        orderId: order[0].orderId,
        amount: totalAmount,
        advancePaid: advanceAmount,
        balance: balanceAmount,
      });

      results.summary.successfulImports++;
    } catch (error) {
      await session.abortTransaction();
      console.error("Error processing row:", error);
      results.errors.push({
        bookingNo: row["Booking NO."] || "Unknown",
        error: error.message,
      });
      results.summary.failedImports++;
    } finally {
      session.endSession();
    }
  }

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
        deliveryMoment.isSameOrBefore(endMoment, "day") &&
        slot.month === month
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
