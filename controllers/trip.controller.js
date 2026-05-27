import catchAsync from "../utility/catchAsync.js";
import Trip from "../models/trip.model.js";
import Vehicle from "../models/vehicleModel.model.js";
import mongoose from "mongoose";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";

const createTrip = catchAsync(async (req, res, next) => {
  const {
    vehicleId,
    driverName,
    driverContact,
    dispatchId,
    orderIds,
    startDate,
    origin,
    destination,
    totalPlants,
    totalCrates,
    notes,
  } = req.body;

  // Validate vehicle exists
  const vehicle = await Vehicle.findById(vehicleId);
  if (!vehicle) {
    return next(new AppError("Vehicle not found", 404));
  }

  if (!vehicle.isActive) {
    return next(new AppError("Vehicle is not active", 400));
  }

  const trip = await Trip.create({
    vehicleId,
    vehicleName: vehicle.name,
    vehicleNumber: vehicle.number,
    driverName,
    driverContact,
    dispatchId,
    orderIds: orderIds || [],
    startDate: startDate || new Date(),
    origin,
    destination,
    totalPlants: totalPlants || 0,
    totalCrates: totalCrates || 0,
    notes,
    createdBy: req.user?.id,
  });

  const response = generateResponse(
    "Success",
    "Trip created successfully",
    trip,
    undefined
  );

  return res.status(201).json(response);
});

const getAllTrips = catchAsync(async (req, res, next) => {
  const {
    sortKey = "startDate",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 10,
    status,
    vehicleId,
  } = req.query;

  let query = Trip.find();

  // Apply search filter
  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { tripNumber: searchRegex },
      { vehicleName: searchRegex },
      { vehicleNumber: searchRegex },
      { driverName: searchRegex },
    ]);
  }

  // Apply status filter
  if (status) {
    query = query.where("status").equals(status);
  }

  // Apply vehicle filter
  if (vehicleId) {
    query = query.where("vehicleId").equals(vehicleId);
  }

  // Apply sorting
  const sort = {};
  sort[sortKey] = sortOrder === "desc" ? -1 : 1;
  query = query.sort(sort);

  // Apply pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  query = query
    .populate("vehicleId", "name number capacity ownerId")
    .populate({
      path: "dispatchId",
      select:
        "transportId transportStatus ownerId driverId vehicleId routeNotes driverRemark vehicleRemark vehicleName vehicleNumber driverName",
      populate: [
        { path: "ownerId", select: "name mobile" },
        { path: "driverId", select: "name mobile" },
      ],
    })
    .populate({
      path: "orderIds",
      select: "orderId orderStatus freightCharges numberOfPlants",
      populate: { path: "farmer", select: "name village mobileNumber" },
    });

  // Execute query
  const [trips, total] = await Promise.all([
    query.exec(),
    Trip.countDocuments(query.getFilter()),
  ]);

  const response = generateResponse(
    "Success",
    "Trips fetched successfully",
    {
      data: trips,
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

const getTripById = catchAsync(async (req, res, next) => {
  const trip = await Trip.findById(req.params.id)
    .populate("vehicleId", "name number capacity")
    .populate({
      path: "dispatchId",
      select:
        "transportId transportStatus ownerId driverId vehicleId routeNotes driverRemark vehicleRemark",
      populate: [
        { path: "ownerId", select: "name mobile" },
        { path: "driverId", select: "name mobile" },
      ],
    })
    .populate({
      path: "orderIds",
      select: "orderId orderStatus freightCharges numberOfPlants",
      populate: { path: "farmer", select: "name village mobileNumber" },
    });

  if (!trip) {
    return next(new AppError("No trip found with that ID", 404));
  }

  const response = generateResponse(
    "Success",
    "Trip fetched successfully",
    trip,
    undefined
  );

  return res.status(200).json(response);
});

const getTripsByVehicle = catchAsync(async (req, res, next) => {
  const { vehicleId } = req.params;

  if (!mongoose.isValidObjectId(vehicleId)) {
    return next(new AppError("Invalid vehicle ID format", 400));
  }

  const trips = await Trip.find({ vehicleId })
    .sort({ startDate: -1 })
    .populate("orderIds", "orderId")
    .populate("dispatchId", "transportId");

  const response = generateResponse(
    "Success",
    "Vehicle trips fetched successfully",
    trips,
    undefined
  );

  return res.status(200).json(response);
});

const updateTrip = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const updateData = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid trip ID format", 400));
  }

  // If updating vehicle, validate it exists
  if (updateData.vehicleId) {
    const vehicle = await Vehicle.findById(updateData.vehicleId);
    if (!vehicle) {
      return next(new AppError("Vehicle not found", 404));
    }
    updateData.vehicleName = vehicle.name;
    updateData.vehicleNumber = vehicle.number;
  }

  // If status is being updated to delivered, set endDate
  if (updateData.status === "delivered" && !updateData.endDate) {
    updateData.endDate = new Date();
    updateData.completedBy = req.user?.id;
  }

  const trip = await Trip.findByIdAndUpdate(id, updateData, {
    new: true,
    runValidators: true,
  })
    .populate("vehicleId", "name number capacity")
    .populate("orderIds", "orderId");

  if (!trip) {
    return next(new AppError("No trip found with that ID", 404));
  }

  const response = generateResponse(
    "Success",
    "Trip updated successfully",
    trip,
    undefined
  );

  return res.status(200).json(response);
});

const deleteTrip = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid trip ID format", 400));
  }

  const trip = await Trip.findByIdAndDelete(id);

  if (!trip) {
    return next(new AppError("No trip found with that ID", 404));
  }

  const response = generateResponse(
    "Success",
    "Trip deleted successfully",
    undefined,
    undefined
  );

  return res.status(200).json(response);
});

export {
  createTrip,
  getAllTrips,
  getTripById,
  getTripsByVehicle,
  updateTrip,
  deleteTrip,
};



