import FarmerList from "../models/farmerList.model.js";
import Farmer from "../models/farmer.model.js";
import AppError from "../utility/appError.js";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";

// Get all farmer lists
export const getAllFarmerLists = catchAsync(async (req, res, next) => {
  const lists = await FarmerList.find({ isActive: true })
    .populate("farmers", "name mobileNumber village taluka district")
    .populate("createdBy", "name")
    .sort({ createdAt: -1 });

  const response = generateResponse(
    "Success",
    "Farmer lists fetched successfully",
    lists,
    undefined
  );

  return res.status(200).json(response);
});

// Get a single farmer list by ID
export const getFarmerListById = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const list = await FarmerList.findById(id)
    .populate("farmers", "name mobileNumber village taluka district state")
    .populate("createdBy", "name");

  if (!list) {
    return next(new AppError("Farmer list not found", 404));
  }

  const response = generateResponse(
    "Success",
    "Farmer list fetched successfully",
    list,
    undefined
  );

  return res.status(200).json(response);
});

// Create a new farmer list
export const createFarmerList = catchAsync(async (req, res, next) => {
  const { name, description, farmerIds } = req.body;

  if (!name || !name.trim()) {
    return next(new AppError("List name is required", 400));
  }

  // Check if list name already exists
  const existingList = await FarmerList.findOne({
    name: name.trim(),
    isActive: true,
  });

  if (existingList) {
    return next(new AppError("A list with this name already exists", 400));
  }

  // Validate farmer IDs if provided
  let validFarmerIds = [];
  if (farmerIds && Array.isArray(farmerIds) && farmerIds.length > 0) {
    const farmers = await Farmer.find({ _id: { $in: farmerIds } });
    validFarmerIds = farmers.map((f) => f._id);
    
    if (validFarmerIds.length !== farmerIds.length) {
      return next(new AppError("Some farmer IDs are invalid", 400));
    }
  }

  const newList = await FarmerList.create({
    name: name.trim(),
    description: description || "",
    farmers: validFarmerIds,
    createdBy: req.user?._id || null,
    isActive: true,
  });

  const populatedList = await FarmerList.findById(newList._id)
    .populate("farmers", "name mobileNumber village taluka district")
    .populate("createdBy", "name");

  const response = generateResponse(
    "Success",
    "Farmer list created successfully",
    populatedList,
    undefined
  );

  return res.status(201).json(response);
});

// Update a farmer list
export const updateFarmerList = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { name, description, farmerIds } = req.body;

  const list = await FarmerList.findById(id);

  if (!list) {
    return next(new AppError("Farmer list not found", 404));
  }

  // If name is being updated, check for duplicates
  if (name && name.trim() !== list.name) {
    const existingList = await FarmerList.findOne({
      name: name.trim(),
      isActive: true,
      _id: { $ne: id },
    });

    if (existingList) {
      return next(new AppError("A list with this name already exists", 400));
    }

    list.name = name.trim();
  }

  if (description !== undefined) {
    list.description = description;
  }

  // Update farmers if provided
  if (farmerIds && Array.isArray(farmerIds)) {
    const farmers = await Farmer.find({ _id: { $in: farmerIds } });
    list.farmers = farmers.map((f) => f._id);
  }

  await list.save();

  const populatedList = await FarmerList.findById(id)
    .populate("farmers", "name mobileNumber village taluka district")
    .populate("createdBy", "name");

  const response = generateResponse(
    "Success",
    "Farmer list updated successfully",
    populatedList,
    undefined
  );

  return res.status(200).json(response);
});

// Add farmers to an existing list
export const addFarmersToList = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { farmerIds } = req.body;

  if (!farmerIds || !Array.isArray(farmerIds) || farmerIds.length === 0) {
    return next(new AppError("Please provide farmer IDs to add", 400));
  }

  const list = await FarmerList.findById(id);

  if (!list) {
    return next(new AppError("Farmer list not found", 404));
  }

  // Validate farmer IDs
  const farmers = await Farmer.find({ _id: { $in: farmerIds } });
  const validFarmerIds = farmers.map((f) => f._id);

  if (validFarmerIds.length === 0) {
    return next(new AppError("No valid farmer IDs provided", 400));
  }

  // Add farmers (avoid duplicates)
  const existingFarmerIds = list.farmers.map((id) => id.toString());
  const newFarmerIds = validFarmerIds.filter(
    (id) => !existingFarmerIds.includes(id.toString())
  );

  if (newFarmerIds.length > 0) {
    list.farmers.push(...newFarmerIds);
    await list.save();
  }

  const populatedList = await FarmerList.findById(id)
    .populate("farmers", "name mobileNumber village taluka district")
    .populate("createdBy", "name");

  const response = generateResponse(
    "Success",
    `${newFarmerIds.length} farmers added to list successfully`,
    populatedList,
    undefined
  );

  return res.status(200).json(response);
});

// Remove farmers from a list
export const removeFarmersFromList = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { farmerIds } = req.body;

  if (!farmerIds || !Array.isArray(farmerIds) || farmerIds.length === 0) {
    return next(new AppError("Please provide farmer IDs to remove", 400));
  }

  const list = await FarmerList.findById(id);

  if (!list) {
    return next(new AppError("Farmer list not found", 404));
  }

  // Remove farmers
  list.farmers = list.farmers.filter(
    (farmerId) => !farmerIds.includes(farmerId.toString())
  );

  await list.save();

  const populatedList = await FarmerList.findById(id)
    .populate("farmers", "name mobileNumber village taluka district")
    .populate("createdBy", "name");

  const response = generateResponse(
    "Success",
    "Farmers removed from list successfully",
    populatedList,
    undefined
  );

  return res.status(200).json(response);
});

// Delete (soft delete) a farmer list
export const deleteFarmerList = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const list = await FarmerList.findById(id);

  if (!list) {
    return next(new AppError("Farmer list not found", 404));
  }

  list.isActive = false;
  await list.save();

  const response = generateResponse(
    "Success",
    "Farmer list deleted successfully",
    null,
    undefined
  );

  return res.status(200).json(response);
});
