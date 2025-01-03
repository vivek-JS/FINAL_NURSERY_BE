

import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import APIFeatures from "../utility/apiFeatures.js";
import Tray from "../models/tray.model.js";
import mongoose from "mongoose";
import PlantOutward from "../models/plantOutward.model.js"
const addLabEntry = catchAsync(async (req, res, next) => {
    const { batchId, labData } = req.body;
   
    const plantOutward = await PlantOutward.findOne({ batchId });
    if (!plantOutward) {
      return next(new AppError("No plant outward found with that batch ID", 404));
    }
   
    // Add new lab entry to most recent outward group or create new one
    if (plantOutward.outward.length === 0 || plantOutward.outward[plantOutward.outward.length - 1].labs.length >= 10) {
      // Create new outward group if none exist or last one is full
      plantOutward.outward.push({ labs: [labData] });
    } else {
      // Add to existing last outward group
      plantOutward.outward[plantOutward.outward.length - 1].labs.push(labData);
    }
   
    await plantOutward.save();
   
    const response = generateResponse(
      "Success",
      "Lab entry added successfully",
      plantOutward,
      undefined
    );
   
    return res.status(200).json(response);
   });
   
   const updateLabEntry = catchAsync(async (req, res, next) => {
    const { batchId, outwardId, labId, labData } = req.body;
   
    const doc = await PlantOutward.findOneAndUpdate(
      { 
        batchId,
        "outward._id": outwardId,
        "outward.labs._id": labId
      },
      { 
        $set: { "outward.$.labs.$[lab]": labData }
      },
      {
        arrayFilters: [{ "lab._id": labId }],
        new: true,
        runValidators: true
      }
    );
   
    if (!doc) {
      return next(new AppError("No matching plant outward or lab entry found", 404));
    }
   
    const response = generateResponse(
      "Success",
      "Lab entry updated successfully", 
      doc,
      undefined
    );
   
    return res.status(200).json(response);
   });
   
   const getAllPlantOutwards = catchAsync(async (req, res, next) => {
    const query = PlantOutward.find()
      .populate('batchId', 'batchNumber dateAdded')
      .sort('-createdAt');
   
    const outwards = await query;
   
    return res.status(200).json({
      status: "Success",
      message: "Plant outwards retrieved successfully",
      data: outwards
    });
   });
   
   const getPlantOutwardByBatchId = catchAsync(async (req, res, next) => {
    const { batchId } = req.params;
   
    const outward = await PlantOutward.findOne({ batchId })
      .populate('batchId', 'batchNumber dateAdded');
   
    if (!outward) {
      return next(new AppError("No plant outward found for this batch", 404));
    }
   
    return res.status(200).json({
      status: "Success", 
      message: "Plant outward retrieved successfully",
      data: outward
    });
   });


   
   const addPrimaryInward = catchAsync(async (req, res, next) => {
     const { batchId, primaryInwardData } = req.body;
   
     // Check if plant outward exists for batch
     let plantOutward = await PlantOutward.findOne({ batchId });
   
     if (!plantOutward) {
       // Create new plant outward if it doesn't exist
       plantOutward = new PlantOutward({
         batchId,
         primaryInward: [primaryInwardData]
       });
     } else {
       // Add to existing plant outward
       plantOutward.primaryInward.push(primaryInwardData);
     }
   
     await plantOutward.save();
   
     const response = generateResponse(
       "Success",
       "Primary inward entry added successfully",
       plantOutward,
       undefined
     );
   
     return res.status(200).json(response);
   });
   
   const updatePrimaryInward = catchAsync(async (req, res, next) => {
     const { batchId, primaryInwardId } = req.params;
     const updateData = req.body;
   
     const doc = await PlantOutward.findOneAndUpdate(
       {
         batchId,
         'primaryInward._id': primaryInwardId
       },
       {
         $set: { 'primaryInward.$': updateData }
       },
       {
         new: true,
         runValidators: true
       }
     );
   
     if (!doc) {
       return next(new AppError("No matching plant outward or primary inward entry found", 404));
     }
   
     const response = generateResponse(
       "Success",
       "Primary inward entry updated successfully",
       doc,
       undefined
     );
   
     return res.status(200).json(response);
   });
   
   const deletePrimaryInward = catchAsync(async (req, res, next) => {
     const { batchId, primaryInwardId } = req.params;
   
     const doc = await PlantOutward.findOneAndUpdate(
       { batchId },
       {
         $pull: { primaryInward: { _id: primaryInwardId } }
       },
       { new: true }
     );
   
     if (!doc) {
       return next(new AppError("No plant outward found with that batch ID", 404));
     }
   
     const response = generateResponse(
       "Success",
       "Primary inward entry deleted successfully",
       doc,
       undefined
     );
   
     return res.status(200).json(response);
   });
   
   const getPrimaryInwardByBatchId = catchAsync(async (req, res, next) => {
     const { batchId } = req.params;
   
     const outward = await PlantOutward.findOne({ batchId })
       .populate('batchId', 'batchNumber dateAdded');
   
     if (!outward) {
       return next(new AppError("No plant outward found for this batch", 404));
     }
   
     return res.status(200).json({
       status: "Success",
       message: "Primary inward entries retrieved successfully",
       data: outward.primaryInward
     });
   });
   


   
   

   export {
    addLabEntry,
    updateLabEntry,
    getPlantOutwardByBatchId,
     getAllPlantOutwards,
     addPrimaryInward,
     updatePrimaryInward,
     deletePrimaryInward,
     getPrimaryInwardByBatchId
   };