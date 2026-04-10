import catchAsync from "../utility/catchAsync.js";
import VehicleOwner from "../models/vehicleOwner.model.js";
import Vehicle from "../models/vehicleModel.model.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import mongoose from "mongoose";

const toRow = (doc) => {
  const o = doc.toObject ? doc.toObject() : doc;
  const { _id, ...rest } = o;
  return { id: _id, _id, ...rest };
};

export const createVehicleOwner = catchAsync(async (req, res, next) => {
  const doc = await VehicleOwner.create(req.body);
  return res.status(201).json(
    generateResponse("Success", "Owner created successfully", toRow(doc), undefined)
  );
});

export const getAllVehicleOwners = catchAsync(async (req, res) => {
  const {
    sortKey = "createdAt",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 10,
    status,
  } = req.query;

  let query = VehicleOwner.find();

  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.where("name").regex(searchRegex);
  }

  if (status !== undefined) {
    query = query.where("isActive").equals(status === "true");
  }

  const sort = {};
  sort[sortKey] = sortOrder === "desc" ? -1 : 1;
  query = query.sort(sort);

  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  query = query.skip(skip).limit(parseInt(limit, 10));

  const [rows, total] = await Promise.all([
    query.exec(),
    VehicleOwner.countDocuments(query.getFilter()),
  ]);

  const data = rows.map(toRow);

  return res.status(200).json(
    generateResponse(
      "Success",
      "Owners fetched successfully",
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

export const getActiveVehicleOwners = catchAsync(async (req, res) => {
  const rows = await VehicleOwner.find({ isActive: true }).sort({ name: 1 });
  const data = rows.map(toRow);
  return res.status(200).json(
    generateResponse("Success", "Active owners fetched successfully", data, undefined)
  );
});

export const getVehicleOwnerById = catchAsync(async (req, res, next) => {
  const doc = await VehicleOwner.findById(req.params.id);
  if (!doc) {
    return next(new AppError("No owner found with that ID", 404));
  }
  return res.status(200).json(
    generateResponse("Success", "Owner fetched successfully", toRow(doc), undefined)
  );
});

export const updateVehicleOwner = catchAsync(async (req, res, next) => {
  const id = req.body.id || req.params.id;
  if (!id || !mongoose.isValidObjectId(id)) {
    return next(new AppError("Valid ID is required", 400));
  }

  const doc = await VehicleOwner.findByIdAndUpdate(id, req.body, {
    new: true,
    runValidators: true,
  });

  if (!doc) {
    return next(new AppError("No owner found with that ID", 404));
  }

  return res.status(200).json(
    generateResponse("Success", "Owner updated successfully", toRow(doc), undefined)
  );
});

export const deleteVehicleOwner = catchAsync(async (req, res, next) => {
  const id = req.body.id || req.params.id;
  if (!id || !mongoose.isValidObjectId(id)) {
    return next(new AppError("Valid ID is required", 400));
  }

  const inUse = await Vehicle.exists({ ownerId: id, isActive: true });
  if (inUse) {
    return next(
      new AppError(
        "Cannot deactivate owner: reassign or remove vehicles linked to this owner first",
        400
      )
    );
  }

  const doc = await VehicleOwner.findByIdAndUpdate(
    id,
    { isActive: false },
    { new: true }
  );

  if (!doc) {
    return next(new AppError("No owner found with that ID", 404));
  }

  return res.status(204).json(
    generateResponse("Success", "Owner deactivated successfully", undefined, undefined)
  );
});
