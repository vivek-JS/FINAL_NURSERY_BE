import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import APIFeatures from "../utility/apiFeatures.js";
import Shade from "../models/shadeSchema.model.js";
import mongoose from "mongoose";

// Create Shade
const createShade = catchAsync(async (req, res, next) => {
  const { name, number } = req.body;

  // Check if shade with same number already exists
  const existingShade = await Shade.findOne({ number });
  if (existingShade) {
    return next(new AppError("Shade with this number already exists", 409));
  }

  const doc = await Shade.create({
    name,
    number,
  });

  const response = generateResponse(
    "Success",
    "Shade created successfully",
    doc,
    undefined
  );

  return res.status(201).json(response);
});

// Get All Shades
const getAllShades = catchAsync(async (req, res, next) => {
  const {
    sortKey = "createdAt",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 10,
    status,
  } = req.query;

  let query = Shade.find();

  // Apply search filter
  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([{ name: searchRegex }, { number: searchRegex }]);
  }

  // Apply status filter
  if (status !== undefined) {
    query = query.where("isActive").equals(status === "true");
  }

  // Apply sorting
  const sort = {};
  sort[sortKey] = sortOrder === "desc" ? -1 : 1;
  query = query.sort(sort);

  // Apply pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  // Execute query
  const [shades, total] = await Promise.all([
    query.exec(),
    Shade.countDocuments(query.getFilter()),
  ]);

  const transformedShades = shades.map((shade) => {
    const { _id, ...rest } = shade.toObject();
    return { id: _id, _id, ...rest };
  });

  const response = generateResponse(
    "Success",
    "Shades fetched successfully",
    {
      data: transformedShades,
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

// Update Shade

const updateShade = catchAsync(async (req, res, next) => {
  const { id } = req.body;
  console.log("Update request received for id:", id); // Debug log

  // Check if id exists
  if (!id) {
    return next(new AppError("ID is required", 400));
  }

  // Use mongoose.Types.ObjectId.isValid for ID validation
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return next(new AppError("Invalid ID format", 400));
  }

  // Check if shade exists
  const existingShade = await Shade.findById(id);
  if (!existingShade) {
    return next(new AppError("No shade found with that ID", 404));
  }

  // If updating number, check for duplicates
  if (req.body.number) {
    const duplicateShade = await Shade.findOne({
      number: req.body.number,
      _id: { $ne: id },
    });
    if (duplicateShade) {
      return next(new AppError("Shade with this number already exists", 409));
    }
  }

  // Update shade
  const updateData = {
    ...(req.body.name && { name: req.body.name }),
    ...(req.body.number && { number: req.body.number }),
    ...(typeof req.body.isActive !== "undefined" && {
      isActive: req.body.isActive,
    }),
  };

  const doc = await Shade.findByIdAndUpdate(id, updateData, {
    new: true,
    runValidators: true,
  });

  const response = generateResponse(
    "Success",
    "Shade updated successfully",
    doc,
    undefined
  );

  return res.status(200).json(response);
});
// Toggle Shade Status
const toggleShadeStatus = catchAsync(async (req, res, next) => {
  const { id, isActive } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid ID format", 400));
  }

  if (typeof isActive !== "boolean") {
    return next(new AppError("isActive must be a boolean value", 400));
  }

  const doc = await Shade.findByIdAndUpdate(
    id,
    { isActive },
    {
      new: true,
      runValidators: true,
    }
  );

  if (!doc) {
    return next(new AppError("No shade found with that ID", 404));
  }

  const response = generateResponse(
    "Success",
    `Shade ${isActive ? "activated" : "deactivated"} successfully`,
    doc,
    undefined
  );

  return res.status(200).json(response);
});

export { createShade, getAllShades, updateShade, toggleShadeStatus };
