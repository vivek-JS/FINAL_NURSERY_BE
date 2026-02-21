import mongoose from "mongoose";
import FollowUp from "../models/followUp.model.js";
import Farmer from "../models/farmer.model.js";
import generateResponse from "../utility/responseFormat.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";

export const createAssignment = catchAsync(async (req, res, next) => {
  const { phone, farmerId, scheduledAt, notes } = req.body;

  if (!phone && !farmerId) {
    return next(new AppError("phone or farmerId is required", 400));
  }

  let farmer = null;
  if (farmerId) {
    if (!mongoose.Types.ObjectId.isValid(farmerId)) {
      return next(new AppError("Invalid farmerId", 400));
    }
    farmer = await Farmer.findById(farmerId);
  }

  const normalizedPhone = String(phone || "").replace(/\D/g, "").slice(-10);

  if (!farmer && normalizedPhone) {
    farmer = await Farmer.findOne({ originalPhoneNumber: normalizedPhone }) || await Farmer.findOne({ mobileNumber: Number(normalizedPhone) });
  }

  if (!farmer) {
    // Create a lightweight farmer record
    farmer = await Farmer.create({
      name: "Unknown",
      village: "Unknown",
      taluka: "Unknown",
      district: "Unknown",
      stateName: "Unknown",
      talukaName: "Unknown",
      districtName: "Unknown",
      state: "Unknown",
      mobileNumber: normalizedPhone ? Number(normalizedPhone) : null,
      originalPhoneNumber: normalizedPhone || null,
    });
  }

  const sched = scheduledAt ? new Date(scheduledAt) : new Date();

  const follow = await FollowUp.create({
    farmerId: farmer._id,
    phone: normalizedPhone || String(farmer.mobileNumber || farmer.originalPhoneNumber || ""),
    scheduledAt: sched,
    notes: String(notes || ""),
    source: "public-call-link",
    assignedBy: req.user?._id || null,
  });

  // Update farmer caches
  farmer.lastFollowUpAt = sched;
  farmer.followUpCount = (farmer.followUpCount || 0) + 1;
  await farmer.save();

  return res.status(201).json(generateResponse("success", "Assignment created", { followUp: follow }));
});

export const listAssignments = catchAsync(async (req, res, next) => {
  const filter = req.query.filter || "current";
  const now = new Date();
  const userId = req.user?._id;

  const baseQuery = {
    status: "pending",
    $or: [{ assignedBy: null }, { assignedBy: userId }],
  };

  if (filter === "current") {
    baseQuery.scheduledAt = { $lte: now };
  } else if (filter === "followup") {
    baseQuery.scheduledAt = { $gt: now };
  }

  const items = await FollowUp.find(baseQuery).sort({ scheduledAt: 1 }).limit(500).lean();
  // Populate farmer info
  const farmerIds = [...new Set(items.map((i) => String(i.farmerId)))].filter(Boolean);
  const farmers = await Farmer.find({ _id: { $in: farmerIds } }).select("name mobileNumber village taluka district stateName").lean();
  const farmerMap = new Map(farmers.map((f) => [String(f._id), f]));

  const results = items.map((it) => ({
    ...it,
    farmer: farmerMap.get(String(it.farmerId)) || null,
  }));

  return res.status(200).json(generateResponse("success", "Assignments fetched", { items: results }));
});

export const updateAssignment = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    return next(new AppError("Invalid assignment id", 400));
  }

  const { status, scheduledAt, notes } = req.body;
  const follow = await FollowUp.findById(id);
  if (!follow) return next(new AppError("Assignment not found", 404));

  if (status) {
    follow.status = status;
    if (status === "completed") follow.completedAt = new Date();
  }
  if (scheduledAt) follow.scheduledAt = new Date(scheduledAt);
  if (notes !== undefined) follow.notes = String(notes || "");

  await follow.save();

  // If scheduledAt updated or marked completed, update farmer metadata
  if (follow.farmerId) {
    const farmer = await Farmer.findById(follow.farmerId);
    if (farmer) {
      // update lastFollowUpAt if this is later
      if (!farmer.lastFollowUpAt || new Date(follow.scheduledAt) > new Date(farmer.lastFollowUpAt)) {
        farmer.lastFollowUpAt = follow.scheduledAt;
      }
      await farmer.save();
    }
  }

  return res.status(200).json(generateResponse("success", "Assignment updated", { followUp: follow }));
});

