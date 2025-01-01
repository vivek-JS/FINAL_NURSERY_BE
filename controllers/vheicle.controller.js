import catchAsync from "../utility/catchAsync.js";
import APIFeatures from "../utility/apiFeatures.js";
import Vehicle from "../models/vehicleModel.model.js";
import mongoose from "mongoose";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";

const createVehicle = catchAsync(async (req, res, next) => {
  // Check if vehicle with same number already exists
  const existingVehicle = await Vehicle.findOne({ number: req.body.number });
  if (existingVehicle) {
    return next(new AppError("Vehicle with this number already exists", 409));
  }

  const doc = await Vehicle.create(req.body);

  const response = generateResponse(
    "Success",
    "Vehicle created successfully",
    doc,
    undefined
  );

  return res.status(201).json(response);
});

const getAllVehicles = catchAsync(async (req, res, next) => {
  const {
    sortKey = "createdAt",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 10,
    status
  } = req.query;

  let query = Vehicle.find();

  // Apply search filter
  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { name: searchRegex },
      { number: searchRegex }
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
  const [vehicles, total] = await Promise.all([
    query.exec(),
    Vehicle.countDocuments(query.getFilter())
  ]);

  const transformedVehicles = vehicles.map(vehicle => {
    const { _id, ...rest } = vehicle.toObject();
    return { id: _id, _id, ...rest };
  });

  const response = generateResponse(
    "Success",
    "Vehicles fetched successfully",
    {
      data: transformedVehicles,
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

const getVehicleById = catchAsync(async (req, res, next) => {
  const doc = await Vehicle.findById(req.params.id);

  if (!doc) {
    return next(new AppError("No vehicle found with that ID", 404));
  }

  const response = generateResponse(
    "Success",
    "Vehicle fetched successfully",
    doc,
    undefined
  );

  return res.status(200).json(response);
});

const updateVehicle = catchAsync(async (req, res, next) => {
    const { id } = req.body;
    
    console.log("Received ID:", id); // Debug log
    console.log("ID type:", typeof id); // Check type of id

    // First check if id exists
    if (!id) {
        return next(new AppError("ID is required", 400));
    }

    try {
        // Validate MongoDB ObjectId format
        if (!mongoose.isValidObjectId(id)) { // Changed from Types.ObjectId.isValid
            return next(new AppError("Invalid ID format. Please provide a valid ID", 400));
        }

        // Check if vehicle exists
        const existingVehicle = await Vehicle.findById(id);
        if (!existingVehicle) {
            return next(new AppError("No vehicle found with that ID", 404));
        }

        // If updating number, check for duplicates
        if (req.body.number) {
            const duplicateVehicle = await Vehicle.findOne({
                number: req.body.number,
                _id: { $ne: id }
            });
            if (duplicateVehicle) {
                return next(new AppError("Vehicle with this number already exists", 409));
            }
        }

        // Update vehicle
        const doc = await Vehicle.findByIdAndUpdate(
            id,
            req.body,
            {
                new: true,
                runValidators: true
            }
        );

        const response = generateResponse(
            "Success",
            "Vehicle updated successfully",
            doc,
            undefined
        );

        return res.status(200).json(response);
    } catch (error) {
        console.error("Error in updateVehicle:", error); // Debug log
        return next(new AppError(error.message || "Error updating vehicle", 400));
    }
});
  // Add new controller function for toggling active status
  const toggleVehicleStatus = catchAsync(async (req, res, next) => {
    const { id, isActive } = req.body;
  
    // Validate MongoDB ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new AppError("Invalid ID format. Please provide a valid ID", 400));
    }
  
    // Check if isActive is provided and is boolean
    if (typeof isActive !== 'boolean') {
      return next(new AppError("isActive must be a boolean value", 400));
    }
  
    const doc = await Vehicle.findByIdAndUpdate(
      id,
      { isActive },
      {
        new: true,
        runValidators: true
      }
    );
  
    if (!doc) {
      return next(new AppError("No vehicle found with that ID", 404));
    }
  
    const response = generateResponse(
      "Success",
      `Vehicle ${isActive ? 'activated' : 'deactivated'} successfully`,
      doc,
      undefined
    );
  
    return res.status(200).json(response);
  });
const deleteVehicle = catchAsync(async (req, res, next) => {
  const doc = await Vehicle.findByIdAndUpdate(
    req.body.id,
    { isActive: false },
    { new: true }
  );

  if (!doc) {
    return next(new AppError("No vehicle found with that ID", 404));
  }

  const response = generateResponse(
    "Success",
    "Vehicle deleted successfully",
    undefined,
    undefined
  );

  return res.status(204).json(response);
});

const bulkUpdateVehicles = catchAsync(async (req, res, next) => {
  const { vehicles } = req.body;

  if (!Array.isArray(vehicles)) {
    return next(new AppError("Invalid request format", 400));
  }

  const updatePromises = vehicles.map(async ({ id, ...updateData }) => {
    if (!mongoose.isValidObjectId(id)) {
      throw new AppError(`Invalid ID format: ${id}`, 400);
    }

    const vehicle = await Vehicle.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true }
    );

    if (!vehicle) {
      throw new AppError(`No vehicle found with ID: ${id}`, 404);
    }

    return vehicle;
  });

  const updatedVehicles = await Promise.all(updatePromises);

  const response = generateResponse(
    "Success",
    "Vehicles updated successfully",
    updatedVehicles,
    undefined
  );

  return res.status(200).json(response);
});

const getActiveVehicles = catchAsync(async (req, res, next) => {
  const vehicles = await Vehicle.find({ isActive: true })
    .sort({ name: 1 });

  const transformedVehicles = vehicles.map(vehicle => {
    const { _id, ...rest } = vehicle.toObject();
    return { id: _id, _id, ...rest };
  });

  const response = generateResponse(
    "Success",
    "Active vehicles fetched successfully",
    transformedVehicles,
    undefined
  );

  return res.status(200).json(response);
});

export {
  createVehicle,
  getAllVehicles,
  getVehicleById,
  updateVehicle,
  deleteVehicle,
  bulkUpdateVehicles,
  getActiveVehicles
};