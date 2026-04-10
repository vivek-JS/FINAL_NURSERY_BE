import catchAsync from "../utility/catchAsync.js";
import VehicleDriver from "../models/vehicleDriver.model.js";
import VehicleOwner from "../models/vehicleOwner.model.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import mongoose from "mongoose";

const toRow = (doc) => {
  const o = doc.toObject ? doc.toObject() : doc;
  const { _id, ...rest } = o;
  return { id: _id, _id, ...rest };
};

export const createVehicleDriver = catchAsync(async (req, res, next) => {
  const owner = await VehicleOwner.findById(req.body.ownerId);
  if (!owner) {
    return next(new AppError("Owner not found", 404));
  }

  const doc = await VehicleDriver.create(req.body);
  return res.status(201).json(
    generateResponse("Success", "Driver created successfully", toRow(doc), undefined)
  );
});

export const getDriversByOwner = catchAsync(async (req, res, next) => {
  const { ownerId } = req.params;
  if (!mongoose.isValidObjectId(ownerId)) {
    return next(new AppError("Invalid owner id", 400));
  }

  const rows = await VehicleDriver.find({ ownerId, isActive: true }).sort({ name: 1 });
  const data = rows.map(toRow);
  return res.status(200).json(
    generateResponse("Success", "Drivers fetched successfully", data, undefined)
  );
});

export const getAllVehicleDrivers = catchAsync(async (req, res) => {
  const { ownerId, search, page = 1, limit = 50 } = req.query;

  let query = VehicleDriver.find();

  if (ownerId && mongoose.isValidObjectId(ownerId)) {
    query = query.where("ownerId").equals(ownerId);
  }

  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([{ name: searchRegex }, { mobile: searchRegex }]);
  }

  query = query.sort({ name: 1 });
  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  query = query.skip(skip).limit(parseInt(limit, 10));

  const [rows, total] = await Promise.all([
    query.populate("ownerId", "name mobile").exec(),
    VehicleDriver.countDocuments(query.getFilter()),
  ]);

  const data = rows.map(toRow);

  return res.status(200).json(
    generateResponse(
      "Success",
      "Drivers fetched successfully",
      {
        data,
        pagination: {
          total,
          page: parseInt(page, 10),
          limit: parseInt(limit, 10),
          pages: Math.ceil(total / parseInt(limit, 10)) || 0,
        },
      },
      undefined
    )
  );
});

export const updateVehicleDriver = catchAsync(async (req, res, next) => {
  const id = req.body.id || req.params.id;
  if (!id || !mongoose.isValidObjectId(id)) {
    return next(new AppError("Valid ID is required", 400));
  }

  if (req.body.ownerId) {
    const owner = await VehicleOwner.findById(req.body.ownerId);
    if (!owner) {
      return next(new AppError("Owner not found", 404));
    }
  }

  const doc = await VehicleDriver.findByIdAndUpdate(id, req.body, {
    new: true,
    runValidators: true,
  });

  if (!doc) {
    return next(new AppError("No driver found with that ID", 404));
  }

  return res.status(200).json(
    generateResponse("Success", "Driver updated successfully", toRow(doc), undefined)
  );
});

export const deleteVehicleDriver = catchAsync(async (req, res, next) => {
  const id = req.body.id || req.params.id;
  if (!id || !mongoose.isValidObjectId(id)) {
    return next(new AppError("Valid ID is required", 400));
  }

  const doc = await VehicleDriver.findByIdAndUpdate(
    id,
    { isActive: false },
    { new: true }
  );

  if (!doc) {
    return next(new AppError("No driver found with that ID", 404));
  }

  return res.status(204).json(
    generateResponse("Success", "Driver deactivated successfully", undefined, undefined)
  );
});
