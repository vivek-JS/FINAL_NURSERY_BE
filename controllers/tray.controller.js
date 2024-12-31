import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import APIFeatures from "../utility/apiFeatures.js";
import Tray from "../models/tray.model.js";
import mongoose from "mongoose";

const createTray = catchAsync(async (req, res, next) => {
  const { name, cavity } = req.body;

  // Check if tray with same name already exists
  const existingTray = await Tray.findOne({ name });
  if (existingTray) {
    return next(new AppError("Tray with this name already exists", 409));
  }

  const doc = await Tray.create({
    name,
    cavity
  });

  const response = generateResponse(
    "Success",
    "Tray created successfully",
    doc,
    undefined
  );

  return res.status(201).json(response);
});

const getAllTrays = catchAsync(async (req, res, next) => {
  const {
    sortKey = "createdAt",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 10,
    status
  } = req.query;

  let query = Tray.find();

  // Apply search filter
  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { name: searchRegex }
    ]);
  }

  // Apply status filter
  if (status !== undefined) {
    query = query.where('isActive').equals(status === 'true');
  }

  // Apply sorting
  const sort = {};
  sort[sortKey] = sortOrder === "desc" ? -1 : 1;
  query = query.sort(sort);

  // Apply pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  // Execute query
  const [trays, total] = await Promise.all([
    query.exec(),
    Tray.countDocuments(query.getFilter())
  ]);

  const transformedTrays = trays.map(tray => {
    const { _id, ...rest } = tray.toObject();
    return { id: _id, _id, ...rest };
  });

  const response = generateResponse(
    "Success",
    "Trays fetched successfully",
    {
      data: transformedTrays,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    },
    undefined
  );

  return res.status(200).json(response);
});

const updateTray = catchAsync(async (req, res, next) => {
  const { id } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid ID format", 400));
  }

  // Check if tray exists
  const existingTray = await Tray.findById(id);
  if (!existingTray) {
    return next(new AppError("No tray found with that ID", 404));
  }

  // If updating name, check for duplicates
  if (req.body.name && req.body.name !== existingTray.name) {
    const duplicateTray = await Tray.findOne({
      name: req.body.name,
      _id: { $ne: id }
    });
    if (duplicateTray) {
      return next(new AppError("Tray with this name already exists", 409));
    }
  }

  const doc = await Tray.findByIdAndUpdate(
    id,
    req.body,
    {
      new: true,
      runValidators: true
    }
  );

  const response = generateResponse(
    "Success",
    "Tray updated successfully",
    doc,
    undefined
  );

  return res.status(200).json(response);
});

const toggleTrayStatus = catchAsync(async (req, res, next) => {
  const { id, isActive } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid ID format", 400));
  }

  if (typeof isActive !== 'boolean') {
    return next(new AppError("isActive must be a boolean value", 400));
  }

  const doc = await Tray.findByIdAndUpdate(
    id,
    { isActive },
    {
      new: true,
      runValidators: true
    }
  );

  if (!doc) {
    return next(new AppError("No tray found with that ID", 404));
  }

  const response = generateResponse(
    "Success",
    `Tray ${isActive ? 'activated' : 'deactivated'} successfully`,
    doc,
    undefined
  );

  return res.status(200).json(response);
});

export {
  createTray,
  getAllTrays,
  updateTray,
  toggleTrayStatus
};