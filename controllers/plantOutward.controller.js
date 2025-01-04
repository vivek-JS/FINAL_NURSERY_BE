

import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import APIFeatures from "../utility/apiFeatures.js";
import Tray from "../models/tray.model.js";
import mongoose from "mongoose";
import PlantOutward from "../models/plantOutward.model.js"
const addLabEntry = catchAsync(async (req, res, next) => {
  const { batchId, labData } = req.body;

  console.log('Received payload:', { batchId, labData });

  const plantOutward = await PlantOutward.findOne({ batchId });
  if (!plantOutward) {
    return next(new AppError("No plant outward found with that batch ID", 404));
  }

  // Create a proper lab entry object with exact schema match
  const newLabEntry = {
    outwardDate: new Date(labData.outwardDate),
    size: labData.size,
    bottles: Number(labData.bottles), // Using Number instead of parseInt
    plants: Number(labData.plants),
    rootingDate: new Date(labData.rootingDate)
  };

  // Log the formatted entry for debugging
  console.log('Formatted lab entry:', newLabEntry);

  try {
    // Use findOneAndUpdate instead of save to ensure proper validation
    const updatedPlantOutward = await PlantOutward.findOneAndUpdate(
      { _id: plantOutward._id },
      { $push: { outward: newLabEntry } },
      { 
        new: true, 
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );

    if (!updatedPlantOutward) {
      return next(new AppError("Failed to update plant outward", 400));
    }

    const response = generateResponse(
      "Success",
      "Lab entry added successfully",
      updatedPlantOutward,
      undefined
    );

    return res.status(200).json(response);

  } catch (error) {
    console.error('Validation/Save Error:', error);
    return next(new AppError(
      `Error processing lab entry: ${error.message}`, 
      400
    ));
  }
});
const updateLabEntry = catchAsync(async (req, res, next) => {
  const { batchId, labId, labData } = req.body; // Removed outwardId as it's no longer needed

  const doc = await PlantOutward.findOneAndUpdate(
    { 
      batchId,
      "outward._id": labId // Simplified query
    },
    { 
      $set: { "outward.$": labData } // Updated to directly set the lab entry
    },
    {
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

// getAllPlantOutwards remains the same as it doesn't deal with the internal structure
const getAllPlantOutwards = catchAsync(async (req, res, next) => {
  const {
    batchId,
    startDate,
    endDate,
    primary,
    lab,
    labroot,
    primaryexpected
  } = req.query;

  // Initialize query object
  const queryObj = {};

  // Add batchId filter if provided
  if (batchId) {
    queryObj.batchId = batchId;
  }

  // Handle date range filters based on different conditions
  if (startDate && endDate) {
    // Convert dates to ISO format
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999); // Include the entire end date

    if (primary === 'true') {
      // Search in primaryInward array for primaryInwardDate
      queryObj['primaryInward'] = {
        $elemMatch: {
          primaryInwardDate: {
            $gte: start,
            $lte: end
          }
        }
      };
    } else if (lab === 'true') {
      // Search in outward array for outwardDate
      queryObj['outward'] = {
        $elemMatch: {
          outwardDate: {
            $gte: start,
            $lte: end
          }
        }
      };
    } else if (labroot === 'true') {
      // Search in outward array for rootingDate
      queryObj['outward'] = {
        $elemMatch: {
          rootingDate: {
            $gte: start,
            $lte: end
          }
        }
      };
    } else if (primaryexpected === 'true') {
      // Search in primaryInward array for primaryOutwardExpectedDate
      queryObj['primaryInward'] = {
        $elemMatch: {
          primaryOutwardExpectedDate: {
            $gte: start,
            $lte: end
          }
        }
      };
    }
  }

  // Build and execute query
  const query = PlantOutward.find(queryObj)
    .populate('batchId', 'batchNumber dateAdded')
    .sort('-createdAt');

  const outwards = await query;

  // If no results found, return empty array with success status
  if (!outwards.length) {
    return res.status(200).json({
      status: "Success",
      message: "No plant outwards found matching the criteria",
      data: []
    });
  }

  return res.status(200).json({
    status: "Success",
    message: "Plant outwards retrieved successfully",
    data: outwards
  });
});
// getPlantOutwardByBatchId remains the same as it doesn't deal with the internal structure
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
  console.log(primaryInwardData)

  // Calculate total quantity before saving
  primaryInwardData.totalQuantity = primaryInwardData.cavity * primaryInwardData.numberOfTrays;
  const size = primaryInwardData.size;

  // Check if plant outward exists for batch
  let plantOutward = await PlantOutward.findOne({ batchId });

  if (!plantOutward) {
    return next(new AppError("No outward entries exist for this batch", 400));
  }

  // Check if there are enough total bottles in the summary for this size
  const currentSummaryForSize = plantOutward.summary[size];
  if (currentSummaryForSize.totalBottles < primaryInwardData.numberOfBottles) {
    return next(new AppError(`Insufficient bottles available for ${size}. Available: ${currentSummaryForSize.totalBottles - currentSummaryForSize.primaryInwardBottles}, Requested: ${primaryInwardData.numberOfBottles}`, 400));
  }

  // Calculate new summary values
  const newBottles = primaryInwardData.numberOfBottles;
  const newPlants = primaryInwardData.cavity * primaryInwardData.numberOfTrays;

  // Create updated summary
  const updatedSummary = {
    ...plantOutward.summary,
    [size]: {
      ...plantOutward.summary[size],
      primaryInwardBottles: plantOutward.summary[size].primaryInwardBottles - newBottles,
      primaryInwardPlants: plantOutward.summary[size].primaryInwardPlants - newPlants
    },
    total: {
      ...plantOutward.summary.total,
      primaryInwardBottles: plantOutward.summary.total.primaryInwardBottles - newBottles,
      primaryInwardPlants: plantOutward.summary.total.primaryInwardPlants - newPlants
    }
  };

  // Update document with new primary inward and summary
  plantOutward = await PlantOutward.findOneAndUpdate(
    { 
      _id: plantOutward._id,
      // Additional validation in query to ensure totalBottles is still sufficient
      [`summary.${size}.totalBottles`]: { $gte: primaryInwardData.numberOfBottles }
    },
    { 
      $push: { primaryInward: primaryInwardData },
      $set: { summary: updatedSummary }
    },
    { new: true, runValidators: true }
  );

  if (!plantOutward) {
    return next(new AppError("Failed to add primary inward entry - insufficient bottles", 400));
  }

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

  // Get the current document first to calculate differences
  const currentDoc = await PlantOutward.findOne(
    { batchId, 'primaryInward._id': primaryInwardId }
  );

  if (!currentDoc) {
    return next(new AppError("No matching plant outward found", 404));
  }

  const currentEntry = currentDoc.primaryInward.find(
    item => item._id.toString() === primaryInwardId
  );

  if (!currentEntry) {
    return next(new AppError("No matching primary inward entry found", 404));
  }

  // Calculate new total quantity if needed
  if (updateData.cavity || updateData.numberOfTrays) {
    updateData.totalQuantity = 
      (updateData.cavity || currentEntry.cavity) * 
      (updateData.numberOfTrays || currentEntry.numberOfTrays);
  }

  const size = currentEntry.size;
  const newBottles = updateData.numberOfBottles || currentEntry.numberOfBottles;
  
  // If updating bottles, check if the difference is available in total bottles
  if (updateData.numberOfBottles) {
    const bottlesDifference = newBottles - currentEntry.numberOfBottles;
    if (bottlesDifference > 0) {
      // If requesting more bottles, check if available
      const availableBottles = currentDoc.summary[size].totalBottles + currentEntry.numberOfBottles;
      if (availableBottles < newBottles) {
        return next(new AppError(`Insufficient bottles available for ${size}. Available: ${availableBottles}, Requested: ${newBottles}`, 400));
      }
    }
  }

  // Calculate all differences for summary update
  const currentPlants = currentEntry.cavity * currentEntry.numberOfTrays;
  const newPlants = updateData.totalQuantity || currentPlants;
  
  const bottlesDiff = currentEntry.numberOfBottles - newBottles;
  const plantsDiff = currentPlants - newPlants;

  // Create updated summary
  const updatedSummary = {
    ...currentDoc.summary,
    [size]: {
      ...currentDoc.summary[size],
      primaryInwardBottles: currentDoc.summary[size].primaryInwardBottles + bottlesDiff,
      primaryInwardPlants: currentDoc.summary[size].primaryInwardPlants + plantsDiff
    },
    total: {
      ...currentDoc.summary.total,
      primaryInwardBottles: currentDoc.summary.total.primaryInwardBottles + bottlesDiff,
      primaryInwardPlants: currentDoc.summary.total.primaryInwardPlants + plantsDiff
    }
  };

  // Update document with additional validation
  const doc = await PlantOutward.findOneAndUpdate(
    {
      batchId,
      'primaryInward._id': primaryInwardId,
      // Additional validation in query if increasing bottles
      ...(updateData.numberOfBottles && updateData.numberOfBottles > currentEntry.numberOfBottles 
        ? { [`summary.${size}.totalBottles`]: { 
            $gte: updateData.numberOfBottles - currentEntry.numberOfBottles 
          }} 
        : {})
    },
    {
      $set: {
        'primaryInward.$': updateData,
        summary: updatedSummary
      }
    },
    {
      new: true,
      runValidators: true
    }
  );

  if (!doc) {
    return next(new AppError("Failed to update primary inward entry - insufficient bottles", 404));
  }

  const response = generateResponse(
    "Success",
    "Primary inward entry updated successfully",
    doc,
    undefined
  );

  return res.status(200).json(response);
});

// Helper function to delete a primary inward entry
const deletePrimaryInward = catchAsync(async (req, res, next) => {
  const { batchId, primaryInwardId } = req.params;

  // First get the current entry to calculate summary adjustments
  const currentDoc = await PlantOutward.findOne(
    { batchId, 'primaryInward._id': primaryInwardId },
    { 'primaryInward.$': 1 }
  );

  if (!currentDoc || !currentDoc.primaryInward[0]) {
    return next(new AppError("No matching primary inward entry found", 404));
  }

  const entryToDelete = currentDoc.primaryInward[0];
  const size = entryToDelete.size;
  const bottlesToAdd = entryToDelete.numberOfBottles;
  const plantsToAdd = entryToDelete.cavity * entryToDelete.numberOfTrays;

  // Update document - remove entry and adjust summary
  const doc = await PlantOutward.findOneAndUpdate(
    { batchId },
    {
      $pull: { primaryInward: { _id: primaryInwardId } },
      $inc: {
        [`summary.${size}.primaryInwardBottles`]: bottlesToAdd,
        [`summary.${size}.primaryInwardPlants`]: plantsToAdd,
        'summary.total.primaryInwardBottles': bottlesToAdd,
        'summary.total.primaryInwardPlants': plantsToAdd
      }
    },
    { new: true }
  );

  if (!doc) {
    return next(new AppError("Failed to delete primary inward entry", 404));
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