import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import APIFeatures from "../utility/apiFeatures.js";
import Batch from "../models/batch.model.js";
import mongoose from "mongoose";
import PlantOutward from "../models/plantOutward.model.js"; // Add this import

// Update batch.controller.js

const createBatch = catchAsync(async (req, res, next) => {
    const { batchNumber, dateAdded } = req.body;
   
    const existingBatch = await Batch.findOne({ batchNumber });
    if (existingBatch) {
      return next(new AppError("Batch number already exists", 409));
    }
   
    const batch = await Batch.create({
      batchNumber,
      dateAdded
    });
   
    // Create plant outward entry with the batch ID
    await PlantOutward.create({
      batchId: batch._id,
      labs: []
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
   status
 } = req.query;

 let query = Batch.find();

 if (search) {
   const searchRegex = new RegExp(search, "i");
   query = query.or([
     { batchNumber: searchRegex }
   ]);
 }

 if (status !== undefined) {
   query = query.where('isActive').equals(status === 'true');
 }

 const sort = {};
 sort[sortKey] = sortOrder === "desc" ? -1 : 1;
 query = query.sort(sort);

 const skip = (parseInt(page) - 1) * parseInt(limit);
 query = query.skip(skip).limit(parseInt(limit));

 const [batches, total] = await Promise.all([
   query.exec(),
   Batch.countDocuments(query.getFilter())
 ]);

 const transformedBatches = batches.map(batch => {
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
       pages: Math.ceil(total / parseInt(limit))
     }
   },
   undefined
 );

 return res.status(200).json(response);
});

const updateBatch = catchAsync(async (req, res, next) => {
 const { id, batchNumber, dateAdded } = req.body;

 if (!mongoose.isValidObjectId(id)) {
   return next(new AppError("Invalid ID format", 400));
 }

 const existingBatch = await Batch.findById(id);
 if (!existingBatch) {
   return next(new AppError("No batch found with that ID", 404));
 }

 if (batchNumber && batchNumber !== existingBatch.batchNumber) {
   const duplicateBatch = await Batch.findOne({
     batchNumber,
     _id: { $ne: id }
   });
   if (duplicateBatch) {
     return next(new AppError("Batch number already exists", 409));
   }
 }

 const doc = await Batch.findByIdAndUpdate(
   id,
   req.body,
   {
     new: true,
     runValidators: true
   }
 );

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

 if (typeof isActive !== 'boolean') {
   return next(new AppError("isActive must be a boolean value", 400));
 }

 const doc = await Batch.findByIdAndUpdate(
   id,
   { isActive },
   {
     new: true,
     runValidators: true
   }
 );

 if (!doc) {
   return next(new AppError("No batch found with that ID", 404));
 }

 const response = generateResponse(
   "Success",
   `Batch ${isActive ? 'activated' : 'deactivated'} successfully`,
   doc,
   undefined
 );

 return res.status(200).json(response);
});

export {
 createBatch,
 getAllBatches,
 updateBatch,
 toggleBatchStatus
};