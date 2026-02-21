import Farmer from "../models/farmer.model.js";
import Order from "../models/order.model.js";
import AppError from "../utility/appError.js";
import catchAsync from "../utility/catchAsync.js";
import { getAll, updateOne, deleteOne } from "./factory.controller.js";
import XLSX from "xlsx";
import fs from "fs";
import generateResponse from "../utility/responseFormat.js";

const getFarmers = getAll(Farmer, "Farmer");
const updateFarmer = updateOne(Farmer, "Farmer");
const deleteFarmer = deleteOne(Farmer, "Farmer");

const findFarmer = catchAsync(async (req, res, next) => {
  const { mobileNumber } = req.params;
  const farmer = await Farmer.findOne({ mobileNumber });

  if (farmer) {
    // Return the farmer record if found
    return res.status(200).json({
      status: "success",
      message: "Farmer record found",
      data: farmer,
    });
  }

  // Return a "No record found" message if no farmer is found
  return res.status(404).json({
    status: "fail",
    message: "No record found for the given mobile number",
  });
});

const createFarmer = catchAsync(async (req, res, next) => {
  let farmer = await Farmer.findOne({ mobileNumber: req.body.mobileNumber });

  if (!farmer) {
    farmer = await new Farmer(req.body).save();
  }

  // Handle referral logic if referredBy is provided
  if (req.body.referredBy) {
    try {
      // Find the referring farmer
      const referringFarmer = await Farmer.findById(req.body.referredBy);
      
      if (referringFarmer) {
        // Add this farmer to the referring farmer's referredTo array
        await Farmer.findByIdAndUpdate(
          req.body.referredBy,
          {
            $push: {
              referredTo: {
                farmerId: farmer._id,
                orderId: null // Will be updated when order is created
              }
            }
          }
        );
      }
    } catch (error) {
      console.error("Error handling referral:", error);
      // Don't fail the farmer creation if referral fails
    }
  }

  req.body.farmer = farmer._id;
  next();
});

// Upload excel sheet of farmers and this will add them into database
const uploadFarmers = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  // Read the Excel file
  const workbook = XLSX.readFile(req.file.path);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(worksheet);

  // Validate required fields
  const requiredFields = [
    "name",
    "village",
    "taluka",
    "district",
    "stateName",
    "talukaName",
    "districtName",
    "state",
    "mobileNumber",
  ];

  const invalidRows = [];
  const validData = [];

  // Process each row
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const missingFields = requiredFields.filter((field) => !row[field]);

    if (missingFields.length > 0) {
      invalidRows.push({
        row: i + 2, // Adding 2 because Excel rows start from 1 and first row is header
        missingFields,
      });
      continue;
    }

    // Convert mobile number to number type if it's string
    if (typeof row.mobileNumber === "string") {
      row.mobileNumber = parseInt(row.mobileNumber);
    }

    validData.push(row);
  }

  if (invalidRows.length > 0) {
    return res.status(400).json({
      error: "Invalid data in Excel file",
      invalidRows,
    });
  }

  // Insert valid data into database
  const result = await Farmer.insertMany(validData, { ordered: false });

  // Clean up - delete the uploaded file
  fs.unlinkSync(req.file.path);

  return res.status(200).json({
    status: "success",
    message: "Data imported successfully",
    insertedCount: result.length,
  });
});

// Get orders of particular farmer
const getFarmerOrder = catchAsync(async(req, res, next) => {
  const {farmerId, orderId} = req.params;

  const farmer = await Farmer.findById(farmerId);

  if(!farmer){
    return next(new AppError("Farmer not found", 404));
  }

  let farmerOrders;

  if(!orderId){
    farmerOrders = await Order.find({ farmer: farmerId})
  } else {
    farmerOrders = await Order.find({ orderId, farmer: farmerId });
  }

  if (!farmerOrders || farmerOrders.length === 0) {
    return next(new AppError("Order not found", 404));
  }

  const response = generateResponse(
    "Success",
    `Orders / order found successfully`,
    farmerOrders,
    undefined
  );

  return res.status(200).json(response);
});

// Get all farmers with invalid phone numbers
const getInvalidPhoneFarmers = catchAsync(async (req, res, next) => {
  try {
    const farmers = await Farmer.find({ isInvalidPhone: true });
    res.status(200).json({ status: 'success', data: farmers });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Update farmer phone number and mark as valid
const updateFarmerPhone = catchAsync(async (req, res, next) => {
  try {
    const { id } = req.params;
    const { phoneNumber } = req.body;
    if (!phoneNumber || phoneNumber.length < 10) {
      return res.status(400).json({ status: 'error', message: 'Valid phone number required' });
    }
    const farmer = await Farmer.findById(id);
    if (!farmer) {
      return res.status(404).json({ status: 'error', message: 'Farmer not found' });
    }
    farmer.phoneNumber = phoneNumber;
    farmer.isInvalidPhone = false;
    farmer.originalPhoneNumber = undefined;
    await farmer.save();
    res.status(200).json({ status: 'success', data: farmer });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Record WhatsApp send history for farmers (and mirror to FarmerLead)
const recordWhatsappHistory = catchAsync(async (req, res, next) => {
  const { farmerIds = [], campaignId = null, message = "", status = "sent", sendEventId = null, timestamp = null } = req.body;

  if (!Array.isArray(farmerIds) || farmerIds.length === 0) {
    return res.status(400).json({ status: "error", message: "farmerIds array is required" });
  }

  const time = timestamp ? new Date(timestamp) : new Date();

  const FarmerLead = (await import("../models/farmerLead.model.js")).default;

  const results = { updatedFarmers: [], updatedLeads: [], errors: [] };

  for (const id of farmerIds) {
    try {
      const farmer = await Farmer.findById(id);
      if (!farmer) {
        results.errors.push({ id, reason: "Farmer not found" });
        continue;
      }

      const entry = {
        automationJobId: null,
        sendEventId: sendEventId || null,
        phone: farmer.mobileNumber ? String(farmer.mobileNumber) : "",
        message,
        status,
        timestamp: time,
      };

      farmer.whatsappAutomationActivities = farmer.whatsappAutomationActivities || [];
      farmer.whatsappAutomationActivities.push(entry);
      await farmer.save();
      results.updatedFarmers.push(farmer._id);

      // Try to find FarmerLead by phone (string) or numeric
      const phoneStr = String(farmer.mobileNumber || "");
      let lead = await FarmerLead.findOne({ mobileNumber: phoneStr });
      if (!lead) {
        // try numeric match if stored differently
        lead = await FarmerLead.findOne({ mobileNumber: String(parseInt(phoneStr || "0", 10)) });
      }
      if (lead) {
        lead.whatsappAutomationActivities = lead.whatsappAutomationActivities || [];
        lead.whatsappAutomationActivities.push(entry);
        await lead.save();
        results.updatedLeads.push(lead._id);
      }
    } catch (e) {
      results.errors.push({ id, reason: e.message || "failed" });
    }
  }

  return res.status(200).json({ status: "success", data: results });
});

export {
  createFarmer,
  updateFarmer,
  deleteFarmer,
  findFarmer,
  getFarmers,
  uploadFarmers,
  getFarmerOrder,
  getInvalidPhoneFarmers,
  updateFarmerPhone
  ,recordWhatsappHistory
};
