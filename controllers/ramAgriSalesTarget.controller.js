import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import RamAgriSalesTarget from "../models/ramAgriSalesTarget.model.js";
import mongoose from "mongoose";

const buildRangeKey = (startDate, endDate) => {
  const startKey = new Date(startDate).toISOString().slice(0, 10);
  const endKey = new Date(endDate).toISOString().slice(0, 10);
  return `${startKey}_${endKey}`;
};

export const getRamAgriSalesTargets = catchAsync(async (req, res, next) => {
  const { userId, startDate, endDate } = req.query;

  const filter = {};
  if (userId && mongoose.isValidObjectId(userId)) {
    filter.userId = userId;
  }

  if (startDate && endDate) {
    filter.rangeKey = buildRangeKey(startDate, endDate);
  }

  const targets = await RamAgriSalesTarget.find(filter)
    .populate("userId", "name phoneNumber jobTitle")
    .sort({ updatedAt: -1 })
    .lean();

  const response = generateResponse(
    "Success",
    "Ram Agri sales targets fetched successfully",
    targets,
    undefined
  );

  return res.status(200).json(response);
});

export const upsertRamAgriSalesTarget = catchAsync(async (req, res, next) => {
  const { userId, startDate, endDate, targets } = req.body;

  if (!userId || !mongoose.isValidObjectId(userId)) {
    return res.status(400).json({
      status: "Error",
      message: "Valid userId is required",
    });
  }

  if (!startDate || !endDate) {
    return res.status(400).json({
      status: "Error",
      message: "startDate and endDate are required",
    });
  }

  if (!Array.isArray(targets)) {
    return res.status(400).json({
      status: "Error",
      message: "targets array is required",
    });
  }

  const startDateObj = new Date(startDate);
  const endDateObj = new Date(endDate);
  const rangeKey = buildRangeKey(startDateObj, endDateObj);

  await RamAgriSalesTarget.deleteMany({ userId, rangeKey });

  const sanitizedTargets = targets
    .filter((item) => item?.cropId && item?.varietyId)
    .map((item) => ({
      userId,
      cropId: item.cropId,
      varietyId: item.varietyId,
      startDate: startDateObj,
      endDate: endDateObj,
      rangeKey,
      targetAmount: Math.max(Number(item.targetAmount || 0), 0),
      createdBy: req.user?._id || req.user?.id,
      updatedBy: req.user?._id || req.user?.id,
    }))
    .filter((item) => item.targetAmount > 0);

  if (sanitizedTargets.length > 0) {
    await RamAgriSalesTarget.insertMany(sanitizedTargets);
  }

  const result = await RamAgriSalesTarget.find({ userId, rangeKey })
    .populate("userId", "name phoneNumber jobTitle")
    .lean();

  const response = generateResponse(
    "Success",
    "Ram Agri sales targets saved successfully",
    result,
    undefined
  );

  return res.status(200).json(response);
});
