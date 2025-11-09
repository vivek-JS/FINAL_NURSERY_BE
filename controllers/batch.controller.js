import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import APIFeatures from "../utility/apiFeatures.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import mongoose from "mongoose";
import PlantOutward from "../models/plantOutward.model.js";

const createBatch = catchAsync(async (req, res, next) => {
  const {
    batchNumber,
    dateAdded,
    primaryPlantReadyDays,
    secondaryPlantReadyDays,
  } = req.body;

  if (!primaryPlantReadyDays || !secondaryPlantReadyDays) {
    return next(
      new AppError("Primary and secondary plant ready days are required", 400)
    );
  }

  const normalizedBatchNumber = batchNumber?.trim();

  if (!normalizedBatchNumber) {
    return next(new AppError("Batch number is required", 400));
  }

  const parsedPrimaryDays = Number(primaryPlantReadyDays);
  const parsedSecondaryDays = Number(secondaryPlantReadyDays);

  if (!Number.isInteger(parsedPrimaryDays) || parsedPrimaryDays <= 0) {
    return next(
      new AppError(
        "Primary plant ready days must be a positive integer",
        400
      )
    );
  }

  if (!Number.isInteger(parsedSecondaryDays) || parsedSecondaryDays <= 0) {
    return next(
      new AppError(
        "Secondary plant ready days must be a positive integer",
        400
      )
    );
  }

  const normalizedDate = dateAdded ? new Date(dateAdded) : new Date();
  if (Number.isNaN(normalizedDate.getTime())) {
    return next(new AppError("Invalid date format", 400));
  }

  const existingBatch = await DispatchBatch.findOne({
    batchNumber: normalizedBatchNumber,
  });
  if (existingBatch) {
    return next(new AppError("Batch number already exists", 409));
  }

  const batch = await DispatchBatch.create({
    batchNumber: normalizedBatchNumber,
    dateAdded: normalizedDate,
    primaryPlantReadyDays: parsedPrimaryDays,
    secondaryPlantReadyDays: parsedSecondaryDays,
  }); 

  await PlantOutward.create({
    batchId: batch._id,
    labs: [],
  });

  const response = generateResponse(
    "Success",
    "Batch created successfully",
    batch,
    undefined
  );

  return res.status(201).json(response);
});

const getAllBatches = catchAsync(async (req, res, next) => {
  const {
    sortKey = "createdAt",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 10,
    status,
    startDate,
    endDate,
  } = req.query;

  let query = DispatchBatch.find();

  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([{ batchNumber: searchRegex }]);
  }

  if (status !== undefined) {
    query = query.where("isActive").equals(status === "true");
  }

  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999);
      query = query.where("dateAdded").gte(start).lte(end);
    }
  }

  const sort = {};
  sort[sortKey] = sortOrder === "desc" ? -1 : 1;
  query = query.sort(sort);

  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  const [batches, total] = await Promise.all([
    query.exec(),
    DispatchBatch.countDocuments(query.getFilter()),
  ]);

  const transformedBatches = batches.map((batch) => {
    const { _id, ...rest } = batch.toObject();
    return { id: _id, _id, ...rest };
  });

  const response = generateResponse(
    "Success",
    "Batches fetched successfully",
    {
      data: transformedBatches,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    undefined
  );

  return res.status(200).json(response);
});
const updateBatch = catchAsync(async (req, res, next) => {
  const {
    id,
    batchNumber,
    dateAdded,
    primaryPlantReadyDays,
    secondaryPlantReadyDays,
  } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid ID format", 400));
  }

  const existingBatch = await DispatchBatch.findById(id);
  if (!existingBatch) {
    return next(new AppError("No batch found with that ID", 404));
  }

  if (batchNumber && batchNumber !== existingBatch.batchNumber) {
    const duplicateBatch = await DispatchBatch.findOne({
      batchNumber: batchNumber.trim(),
      _id: { $ne: id },
    });
    if (duplicateBatch) {
      return next(new AppError("Batch number already exists", 409));
    }
  }

  // Validate plant ready days if they are being updated
  if (
    primaryPlantReadyDays !== undefined &&
    (!Number.isInteger(Number(primaryPlantReadyDays)) ||
      Number(primaryPlantReadyDays) <= 0)
  ) {
    return next(
      new AppError("Primary plant ready days must be a positive number", 400)
    );
  }
  if (
    secondaryPlantReadyDays !== undefined &&
    (!Number.isInteger(Number(secondaryPlantReadyDays)) ||
      Number(secondaryPlantReadyDays) <= 0)
  ) {
    return next(
      new AppError("Secondary plant ready days must be a positive number", 400)
    );
  }

  const updatePayload = { ...req.body };

  delete updatePayload.id;
  delete updatePayload._id;

  if (batchNumber !== undefined) {
    updatePayload.batchNumber = batchNumber.trim();
  }

  if (dateAdded !== undefined) {
    const updatedDate = new Date(dateAdded);
    if (Number.isNaN(updatedDate.getTime())) {
      return next(new AppError("Invalid date format", 400));
    }
    updatePayload.dateAdded = updatedDate;
  }

  if (primaryPlantReadyDays !== undefined) {
    updatePayload.primaryPlantReadyDays = Number(primaryPlantReadyDays);
  }

  if (secondaryPlantReadyDays !== undefined) {
    updatePayload.secondaryPlantReadyDays = Number(secondaryPlantReadyDays);
  }

  const doc = await DispatchBatch.findByIdAndUpdate(id, updatePayload, {
    new: true,
    runValidators: true,
  });

  const response = generateResponse(
    "Success",
    "Batch updated successfully",
    doc,
    undefined
  );

  return res.status(200).json(response);
});

const toggleBatchStatus = catchAsync(async (req, res, next) => {
  const { id, isActive } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid ID format", 400));
  }

  if (typeof isActive !== "boolean") {
    return next(new AppError("isActive must be a boolean value", 400));
  }

  const doc = await DispatchBatch.findByIdAndUpdate(
    id,
    { isActive },
    {
      new: true,
      runValidators: true,
    }
  );

  if (!doc) {
    return next(new AppError("No batch found with that ID", 404));
  }

  const response = generateResponse(
    "Success",
    `Batch ${isActive ? "activated" : "deactivated"} successfully`,
    doc,
    undefined
  );

  return res.status(200).json(response);
});

export { createBatch, getAllBatches, updateBatch, toggleBatchStatus };
