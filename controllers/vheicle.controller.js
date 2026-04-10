import catchAsync from "../utility/catchAsync.js";
import Vehicle from "../models/vehicleModel.model.js";
import VehicleOwner from "../models/vehicleOwner.model.js";
import VehicleDriver from "../models/vehicleDriver.model.js";
import mongoose from "mongoose";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";

async function assertOwnerAndDriverForVehicle(body, existingVehicle = null) {
  if (body.ownerId) {
    if (!mongoose.isValidObjectId(body.ownerId)) {
      throw new AppError("Invalid owner id", 400);
    }
    const owner = await VehicleOwner.findById(body.ownerId);
    if (!owner || !owner.isActive) {
      throw new AppError("Owner not found or inactive", 404);
    }
  }

  if (body.defaultDriverId) {
    if (!mongoose.isValidObjectId(body.defaultDriverId)) {
      throw new AppError("Invalid default driver id", 400);
    }
    const driver = await VehicleDriver.findById(body.defaultDriverId);
    if (!driver || !driver.isActive) {
      throw new AppError("Driver not found or inactive", 404);
    }
    const ownerKey = body.ownerId ?? existingVehicle?.ownerId;
    if (!ownerKey) {
      throw new AppError("Select an owner before assigning a default driver", 400);
    }
    if (String(driver.ownerId) !== String(ownerKey)) {
      throw new AppError(
        "Default driver must belong to the vehicle owner",
        400
      );
    }
  }
}

const createVehicle = catchAsync(async (req, res, next) => {
  // Check if vehicle with same number already exists
  const existingVehicle = await Vehicle.findOne({ number: req.body.number });
  if (existingVehicle) {
    return next(new AppError("Vehicle with this number already exists", 409));
  }

  await assertOwnerAndDriverForVehicle(req.body, null);

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
    status,
    ownerId: ownerIdQuery,
  } = req.query;

  let query = Vehicle.find();

  if (ownerIdQuery && mongoose.isValidObjectId(ownerIdQuery)) {
    query = query.where("ownerId").equals(ownerIdQuery);
  }

  // Apply search filter
  if (search) {
    const searchRegex = new RegExp(search, "i");
    if (ownerIdQuery && mongoose.isValidObjectId(ownerIdQuery)) {
      query = query.and([
        {
          $or: [{ name: searchRegex }, { number: searchRegex }],
        },
      ]);
    } else {
      const ownerMatches = await VehicleOwner.find({ name: searchRegex })
        .select("_id")
        .lean();
      const ownerIds = ownerMatches.map((o) => o._id);
      query = query.and([
        {
          $or: [
            { name: searchRegex },
            { number: searchRegex },
            ...(ownerIds.length ? [{ ownerId: { $in: ownerIds } }] : []),
          ],
        },
      ]);
    }
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

  query = query
    .populate({ path: "ownerId", select: "name mobile" })
    .populate({ path: "defaultDriverId", select: "name mobile" });

  // Execute query
  const [vehicles, total] = await Promise.all([
    query.exec(),
    Vehicle.countDocuments(query.getFilter()),
  ]);

  const transformedVehicles = vehicles.map((vehicle) => {
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
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

const getVehicleById = catchAsync(async (req, res, next) => {
  const doc = await Vehicle.findById(req.params.id)
    .populate({ path: "ownerId", select: "name mobile" })
    .populate({ path: "defaultDriverId", select: "name mobile" });

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
  const id = req.body.id || req.params.id;

  if (!id) {
    return next(new AppError("ID is required", 400));
  }

  try {
    if (!mongoose.isValidObjectId(id)) {
      return next(
        new AppError("Invalid ID format. Please provide a valid ID", 400)
      );
    }

    const existingVehicle = await Vehicle.findById(id);
    if (!existingVehicle) {
      return next(new AppError("No vehicle found with that ID", 404));
    }

    if (req.body.number) {
      const duplicateVehicle = await Vehicle.findOne({
        number: req.body.number,
        _id: { $ne: id },
      });
      if (duplicateVehicle) {
        return next(
          new AppError("Vehicle with this number already exists", 409)
        );
      }
    }

    if (
      req.body.ownerId !== undefined ||
      req.body.defaultDriverId !== undefined
    ) {
      await assertOwnerAndDriverForVehicle(
        {
          ownerId:
            req.body.ownerId !== undefined
              ? req.body.ownerId
              : existingVehicle.ownerId,
          defaultDriverId:
            req.body.defaultDriverId !== undefined
              ? req.body.defaultDriverId
              : existingVehicle.defaultDriverId,
        },
        existingVehicle
      );
    }

    const doc = await Vehicle.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    })
      .populate({ path: "ownerId", select: "name mobile" })
      .populate({ path: "defaultDriverId", select: "name mobile" });

    const response = generateResponse(
      "Success",
      "Vehicle updated successfully",
      doc,
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    console.error("Error in updateVehicle:", error);
    return next(new AppError(error.message || "Error updating vehicle", 400));
  }
});
// Add new controller function for toggling active status
const toggleVehicleStatus = catchAsync(async (req, res, next) => {
  const { id, isActive } = req.body;

  // Validate MongoDB ObjectId format
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return next(
      new AppError("Invalid ID format. Please provide a valid ID", 400)
    );
  }

  // Check if isActive is provided and is boolean
  if (typeof isActive !== "boolean") {
    return next(new AppError("isActive must be a boolean value", 400));
  }

  const doc = await Vehicle.findByIdAndUpdate(
    id,
    { isActive },
    {
      new: true,
      runValidators: true,
    }
  );

  if (!doc) {
    return next(new AppError("No vehicle found with that ID", 404));
  }

  const response = generateResponse(
    "Success",
    `Vehicle ${isActive ? "activated" : "deactivated"} successfully`,
    doc,
    undefined
  );

  return res.status(200).json(response);
});
const deleteVehicle = catchAsync(async (req, res, next) => {
  const id = req.body.id || req.params.id;
  if (!id || !mongoose.isValidObjectId(id)) {
    return next(new AppError("Valid ID is required", 400));
  }

  const doc = await Vehicle.findByIdAndUpdate(
    id,
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
  const filter = { isActive: true };
  if (req.query.ownerId && mongoose.isValidObjectId(req.query.ownerId)) {
    filter.ownerId = req.query.ownerId;
  }

  const vehicles = await Vehicle.find(filter)
    .populate({ path: "ownerId", select: "name mobile" })
    .populate({ path: "defaultDriverId", select: "name mobile" })
    .sort({ name: 1 });

  const transformedVehicles = vehicles.map((vehicle) => {
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
  getActiveVehicles,
};
