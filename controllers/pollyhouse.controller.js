import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import mongoose from "mongoose";
import PollyHouse from "../models/pollyhouse.model.js";

const createPollyHouse = catchAsync(async (req, res, next) => {
  const { name, capacity, location } = req.body;

  const existingHouse = await PollyHouse.findOne({ name });
  if (existingHouse) {
    return next(new AppError("PollyHouse with this name already exists", 409));
  }

  const doc = await PollyHouse.create({
    name,
    capacity,
    location,
  });

  const response = generateResponse(
    "Success",
    "PollyHouse created successfully",
    doc,
    undefined
  );

  return res.status(201).json(response);
});

const getAllPollyHouses = catchAsync(async (req, res, next) => {
  const {
    sortKey = "createdAt",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 10,
    status,
    minCapacity,
    maxCapacity,
  } = req.query;

  let query = PollyHouse.find();

  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([{ name: searchRegex }, { location: searchRegex }]);
  }

  if (status !== undefined) {
    query = query.where("isActive").equals(status === "true");
  }

  if (minCapacity) {
    query = query.where("capacity").gte(parseInt(minCapacity));
  }

  if (maxCapacity) {
    query = query.where("capacity").lte(parseInt(maxCapacity));
  }

  const sort = {};
  sort[sortKey] = sortOrder === "desc" ? -1 : 1;
  query = query.sort(sort);

  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  const [houses, total] = await Promise.all([
    query.exec(),
    PollyHouse.countDocuments(query.getFilter()),
  ]);

  const transformedHouses = houses.map((house) => {
    const { _id, ...rest } = house.toObject();
    return { id: _id, _id, ...rest };
  });

  const response = generateResponse(
    "Success",
    "PollyHouses fetched successfully",
    {
      data: transformedHouses,
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

const updatePollyHouse = catchAsync(async (req, res, next) => {
  const { id, capacity } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid ID format", 400));
  }

  const existingHouse = await PollyHouse.findById(id);
  if (!existingHouse) {
    return next(new AppError("No pollyHouse found with that ID", 404));
  }

  if (req.body.name && req.body.name !== existingHouse.name) {
    const duplicateHouse = await PollyHouse.findOne({
      name: req.body.name,
      _id: { $ne: id },
    });
    if (duplicateHouse) {
      return next(
        new AppError("PollyHouse with this name already exists", 409)
      );
    }
  }

  const doc = await PollyHouse.findByIdAndUpdate(id, req.body, {
    new: true,
    runValidators: true,
  });

  const response = generateResponse(
    "Success",
    "PollyHouse updated successfully",
    doc,
    undefined
  );

  return res.status(200).json(response);
});

const togglePollyHouseStatus = catchAsync(async (req, res, next) => {
  const { id, isActive } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid ID format", 400));
  }

  if (typeof isActive !== "boolean") {
    return next(new AppError("isActive must be a boolean value", 400));
  }

  const doc = await PollyHouse.findByIdAndUpdate(
    id,
    { isActive },
    {
      new: true,
      runValidators: true,
    }
  );

  if (!doc) {
    return next(new AppError("No pollyHouse found with that ID", 404));
  }

  const response = generateResponse(
    "Success",
    `PollyHouse ${isActive ? "activated" : "deactivated"} successfully`,
    doc,
    undefined
  );

  return res.status(200).json(response);
});

export {
  createPollyHouse,
  getAllPollyHouses,
  updatePollyHouse,
  togglePollyHouseStatus,
};
