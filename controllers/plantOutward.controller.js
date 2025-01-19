import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import APIFeatures from "../utility/apiFeatures.js";
import Tray from "../models/tray.model.js";
import mongoose from "mongoose";
import PlantOutward from "../models/plantOutward.model.js";

const addLabEntry = catchAsync(async (req, res, next) => {
  const { batchId, labData } = req.body;

  // console.log("Received payload:", { batchId, labData });

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
    rootingDate: new Date(labData.rootingDate),
  };

  // Log the formatted entry for debugging
  // console.log("Formatted lab entry:", newLabEntry);

  try {
    // Use findOneAndUpdate instead of save to ensure proper validation
    const updatedPlantOutward = await PlantOutward.findOneAndUpdate(
      { _id: plantOutward._id },
      { $push: { outward: newLabEntry } },
      {
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
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
    console.error("Validation/Save Error:", error);
    return next(
      new AppError(`Error processing lab entry: ${error.message}`, 400)
    );
  }
});

const updateLabEntry = catchAsync(async (req, res, next) => {
  const { batchId, labId, labData } = req.body; // Removed outwardId as it's no longer needed

  const doc = await PlantOutward.findOneAndUpdate(
    {
      batchId,
      "outward._id": labId, // Simplified query
    },
    {
      $set: { "outward.$": labData }, // Updated to directly set the lab entry
    },
    {
      new: true,
      runValidators: true,
    }
  );

  if (!doc) {
    return next(
      new AppError("No matching plant outward or lab entry found", 404)
    );
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
    primaryexpected,
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

    if (primary === "true") {
      // Search in primaryInward array for primaryInwardDate
      queryObj["primaryInward"] = {
        $elemMatch: {
          primaryInwardDate: {
            $gte: start,
            $lte: end,
          },
        },
      };
    } else if (lab === "true") {
      // Search in outward array for outwardDate
      queryObj["outward"] = {
        $elemMatch: {
          outwardDate: {
            $gte: start,
            $lte: end,
          },
        },
      };
    } else if (labroot === "true") {
      // Search in outward array for rootingDate
      queryObj["outward"] = {
        $elemMatch: {
          rootingDate: {
            $gte: start,
            $lte: end,
          },
        },
      };
    } else if (primaryexpected === "true") {
      // Search in primaryInward array for primaryOutwardExpectedDate
      queryObj["primaryInward"] = {
        $elemMatch: {
          primaryOutwardExpectedDate: {
            $gte: start,
            $lte: end,
          },
        },
      };
    }
  }

  // Build and execute query
  const query = PlantOutward.find(queryObj)
    .populate("batchId", "batchNumber dateAdded")
    .sort("-createdAt");

  const outwards = await query;

  // If no results found, return empty array with success status
  if (!outwards.length) {
    return res.status(200).json({
      status: "Success",
      message: "No plant outwards found matching the criteria",
      data: [],
    });
  }

  return res.status(200).json({
    status: "Success",
    message: "Plant outwards retrieved successfully",
    data: outwards,
  });
});

// getPlantOutwardByBatchId remains the same as it doesn't deal with the internal structure
const getPlantOutwardByBatchId = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;

  const outward = await PlantOutward.findOne({ batchId }).populate(
    "batchId",
    "batchNumber dateAdded"
  );

  if (!outward) {
    return next(new AppError("No plant outward found for this batch", 404));
  }

  return res.status(200).json({
    status: "Success",
    message: "Plant outward retrieved successfully",
    data: outward,
  });
});

const addPrimaryInward = catchAsync(async (req, res, next) => {
  const { batchId, primaryInwardData } = req.body;
  // console.log(primaryInwardData);

  // Calculate total quantity before saving
  primaryInwardData.totalQuantity =
    primaryInwardData.cavity * primaryInwardData.numberOfTrays;
  const size = primaryInwardData.size;

  // Check if plant outward exists for batch
  let plantOutward = await PlantOutward.findOne({ batchId });

  if (!plantOutward) {
    return next(new AppError("No outward entries exist for this batch", 400));
  }

  // Check if there are enough total bottles in the summary for this size
  const currentSummaryForSize = plantOutward.summary[size];
  if (currentSummaryForSize.totalBottles < primaryInwardData.numberOfBottles) {
    return next(
      new AppError(
        `Insufficient bottles available for ${size}. Available: ${currentSummaryForSize.totalBottles - currentSummaryForSize.primaryInwardBottles}, Requested: ${primaryInwardData.numberOfBottles}`,
        400
      )
    );
  }

  // Calculate new summary values
  const newBottles = primaryInwardData.numberOfBottles;
  const newPlants = primaryInwardData.cavity * primaryInwardData.numberOfTrays;

  // Create updated summary
  const updatedSummary = {
    ...plantOutward.summary,
    [size]: {
      ...plantOutward.summary[size],
      primaryInwardBottles:
        plantOutward.summary[size].primaryInwardBottles - newBottles,
      primaryInwardPlants:
        plantOutward.summary[size].primaryInwardPlants - newPlants,
    },
    total: {
      ...plantOutward.summary.total,
      primaryInwardBottles:
        plantOutward.summary.total.primaryInwardBottles - newBottles,
      primaryInwardPlants:
        plantOutward.summary.total.primaryInwardPlants - newPlants,
    },
  };

  // Update document with new primary inward and summary
  plantOutward = await PlantOutward.findOneAndUpdate(
    {
      _id: plantOutward._id,
      // Additional validation in query to ensure totalBottles is still sufficient
      [`summary.${size}.totalBottles`]: {
        $gte: primaryInwardData.numberOfBottles,
      },
    },
    {
      $push: { primaryInward: primaryInwardData },
      $set: { summary: updatedSummary },
    },
    { new: true, runValidators: true }
  );

  if (!plantOutward) {
    return next(
      new AppError(
        "Failed to add primary inward entry - insufficient bottles",
        400
      )
    );
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
  const currentDoc = await PlantOutward.findOne({
    batchId,
    "primaryInward._id": primaryInwardId,
  });

  if (!currentDoc) {
    return next(new AppError("No matching plant outward found", 404));
  }

  const currentEntry = currentDoc.primaryInward.find(
    (item) => item._id.toString() === primaryInwardId
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
      const availableBottles =
        currentDoc.summary[size].totalBottles + currentEntry.numberOfBottles;
      if (availableBottles < newBottles) {
        return next(
          new AppError(
            `Insufficient bottles available for ${size}. Available: ${availableBottles}, Requested: ${newBottles}`,
            400
          )
        );
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
      primaryInwardBottles:
        currentDoc.summary[size].primaryInwardBottles + bottlesDiff,
      primaryInwardPlants:
        currentDoc.summary[size].primaryInwardPlants + plantsDiff,
    },
    total: {
      ...currentDoc.summary.total,
      primaryInwardBottles:
        currentDoc.summary.total.primaryInwardBottles + bottlesDiff,
      primaryInwardPlants:
        currentDoc.summary.total.primaryInwardPlants + plantsDiff,
    },
  };

  // Update document with additional validation
  const doc = await PlantOutward.findOneAndUpdate(
    {
      batchId,
      "primaryInward._id": primaryInwardId,
      // Additional validation in query if increasing bottles
      ...(updateData.numberOfBottles &&
      updateData.numberOfBottles > currentEntry.numberOfBottles
        ? {
            [`summary.${size}.totalBottles`]: {
              $gte: updateData.numberOfBottles - currentEntry.numberOfBottles,
            },
          }
        : {}),
    },
    {
      $set: {
        "primaryInward.$": updateData,
        summary: updatedSummary,
      },
    },
    {
      new: true,
      runValidators: true,
    }
  );

  if (!doc) {
    return next(
      new AppError(
        "Failed to update primary inward entry - insufficient bottles",
        404
      )
    );
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
    { batchId, "primaryInward._id": primaryInwardId },
    { "primaryInward.$": 1 }
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
        "summary.total.primaryInwardBottles": bottlesToAdd,
        "summary.total.primaryInwardPlants": plantsToAdd,
      },
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

  const outward = await PlantOutward.findOne({ batchId }).populate(
    "batchId",
    "batchNumber dateAdded"
  );

  if (!outward) {
    return next(new AppError("No plant outward found for this batch", 404));
  }

  return res.status(200).json({
    status: "Success",
    message: "Primary inward entries retrieved successfully",
    data: outward.primaryInward,
  });
});

const labToPrimaryInward = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;
  const {
    labEntryId,  // Added this as source
    primaryInwardDate,
    numberOfBottles,
    size,
    cavity,
    numberOfTrays,
    pollyhouse,
    laboursEngaged,
    remarks
  } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Validate required fields
    if (!labEntryId || !primaryInwardDate || !numberOfBottles || !size || !cavity || !numberOfTrays || !pollyhouse) {
      throw new AppError("Missing required fields", 400);
    }

    // Find and validate plant outward document
    const plantOutward = await PlantOutward.findOne({ batchId }).session(session);
    if (!plantOutward) {
      throw new AppError("No plant outward found with this batch ID", 404);
    }

    // Find and validate lab entry
    const labEntry = plantOutward.outward.id(labEntryId);
    if (!labEntry) {
      throw new AppError("Lab entry not found", 404);
    }

    // Calculate available quantities
    const calculatedTotalQuantity = cavity * numberOfTrays;

    // Validate transfer using model method
    try {
      plantOutward.validateTransfer('outward', labEntryId, calculatedTotalQuantity);
    } catch (error) {
      throw new AppError(error.message, 400);
    }

    // Create transfer history entry for lab
    const labTransferHistory = {
      transferDate: primaryInwardDate,
      bottlesTransferred: numberOfBottles,
      plantsTransferred: calculatedTotalQuantity,
      remarks
    };

    // Create primary inward entry
    const primaryInwardEntry = {
      primaryInwardDate,
      numberOfBottles,
      size,
      cavity,
      numberOfTrays,
      totalQuantity: calculatedTotalQuantity,
      availableQuantity: calculatedTotalQuantity,
      pollyhouse,
      laboursEngaged,
      transferStatus: 'available',
      sourceLabId: labEntryId
    };

    // Update lab entry's transfer status
    const newLabStatus = 
      labEntry.availablePlants - calculatedTotalQuantity === 0 ? 
      'fully_transferred' : 'partially_transferred';

    const updatedDoc = await PlantOutward.findOneAndUpdate(
      { batchId, "outward._id": labEntryId },
      {
        $push: {
          primaryInward: primaryInwardEntry,
          "outward.$.transferHistory": labTransferHistory
        },
        $set: {
          "outward.$.transferStatus": newLabStatus,
          "outward.$.availablePlants": labEntry.availablePlants - calculatedTotalQuantity,
          "outward.$.availableBottles": labEntry.availableBottles - numberOfBottles
        }
      },
      { new: true, session, runValidators: true }
    );

    await session.commitTransaction();

    const response = generateResponse(
      "Success",
      "Transfer from lab to primary completed successfully",
      updatedDoc
    );

    res.status(200).json(response);
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});

const primaryInwardToPrimaryOutward = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;
  const {
    primaryInwardId,  // Added this as source
    primaryOutwardDate,
    numberOfBottles,
    size,
    cavity,
    numberOfTrays,
    pollyhouse,
    laboursEngaged,
    remarks,
    qualityOfDispatch,
    isReceived,
    dateOfPlantation,
    numberOfDaysTaken
  } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Validate required fields
    if (!primaryInwardId || !primaryOutwardDate || !numberOfBottles || !size || !cavity || !numberOfTrays || !pollyhouse || !laboursEngaged || !remarks || !qualityOfDispatch || !isReceived || !dateOfPlantation || !numberOfDaysTaken) {
      throw new AppError("Missing required fields", 400);
    }

    const plantOutward = await PlantOutward.findOne({ batchId }).session(session);
    if (!plantOutward) {
      throw new AppError("No plant outward found with this batch ID", 404);
    }

    // Find and validate primary inward entry
    const primaryInward = plantOutward.primaryInward.id(primaryInwardId);
    if (!primaryInward) {
      throw new AppError("Primary inward entry not found", 404);
    }

    const calculatedTotalQuantity = cavity * numberOfTrays;

    // Validate transfer
    try {
      plantOutward.validateTransfer('primaryInward', primaryInwardId, calculatedTotalQuantity);
    } catch (error) {
      throw new AppError(error.message, 400);
    }

    // Create transfer history for primary inward
    const transferHistory = {
      transferDate: primaryOutwardDate,
      quantityTransferred: calculatedTotalQuantity,
      remarks
    };

    // Create primary outward entry
    const primaryOutwardEntry = {
      primaryOutwardDate,
      numberOfBottles,
      size,
      cavity,
      numberOfTrays,
      totalQuantity: calculatedTotalQuantity,
      availableQuantity: calculatedTotalQuantity,
      pollyhouse,
      laboursEngaged,
      transferStatus: 'available',
      remarks,
      qualityOfDispatch,
      isReceived,
      dateOfPlantation,
      numberOfDaysTaken
    };

    const newPrimaryInwardStatus = 
      primaryInward.availableQuantity - calculatedTotalQuantity === 0 ? 
      'fully_transferred' : 'partially_transferred';

    const updatedDoc = await PlantOutward.findOneAndUpdate(
      { batchId, "primaryInward._id": primaryInwardId },
      {
        $push: {
          primaryOutward: primaryOutwardEntry,
          "primaryInward.$.transferHistory": transferHistory
        },
        $set: {
          "primaryInward.$.transferStatus": newPrimaryInwardStatus,
          "primaryInward.$.availableQuantity": primaryInward.availableQuantity - calculatedTotalQuantity
        }
      },
      { new: true, session, runValidators: true }
    );

    await session.commitTransaction();

    const response = generateResponse(
      "Success",
      "Transfer from primary inward to outward completed successfully",
      updatedDoc
    );

    res.status(200).json(response);
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});

const primaryToSecondaryInward = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;
  const {
    primaryOutwardId,  // Added source ID
    secondaryInwardDate,
    numberOfBottles,
    size,
    cavity,
    numberOfTrays,
    pollyhouse,
    laboursEngaged,
    remarks,
    dateOfDispatch
  } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Validate required fields
    if (!primaryOutwardId || !secondaryInwardDate || !numberOfBottles || !size || !cavity || !numberOfTrays || !pollyhouse || !dateOfDispatch) {
      throw new AppError("Missing required fields", 400);
    }

    const plantOutward = await PlantOutward.findOne({ batchId }).session(session);
    if (!plantOutward) {
      throw new AppError("No plant outward found with this batch ID", 404);
    }

    // Find and validate primary outward entry
    const primaryOutward = plantOutward.primaryOutward.id(primaryOutwardId);
    if (!primaryOutward) {
      throw new AppError("Primary outward entry not found", 404);
    }

    const calculatedTotalQuantity = cavity * numberOfTrays;

    // Validate transfer
    try {
      plantOutward.validateTransfer('primaryOutward', primaryOutwardId, calculatedTotalQuantity);
    } catch (error) {
      throw new AppError(error.message, 400);
    }

    // Create transfer history for primary outward
    const transferHistory = {
      transferDate: secondaryInwardDate,
      quantityTransferred: calculatedTotalQuantity,
      remarks
    };

    // Create secondary inward entry
    const secondaryInwardEntry = {
      secondaryInwardDate,
      numberOfBottles,
      size,
      cavity,
      numberOfTrays,
      totalQuantity: calculatedTotalQuantity,
      availableQuantity: calculatedTotalQuantity,
      pollyhouse,
      laboursEngaged,
      transferStatus: 'available',
      sourcePrimaryOutwardId: primaryOutwardId,
      dateOfDispatch
    };

    const newPrimaryOutwardStatus = 
      primaryOutward.availableQuantity - calculatedTotalQuantity === 0 ? 
      'fully_transferred' : 'partially_transferred';

    const updatedDoc = await PlantOutward.findOneAndUpdate(
      { batchId, "primaryOutward._id": primaryOutwardId },
      {
        $push: {
          secondaryInward: secondaryInwardEntry,
          "primaryOutward.$.transferHistory": transferHistory
        },
        $set: {
          "primaryOutward.$.transferStatus": newPrimaryOutwardStatus,
          "primaryOutward.$.availableQuantity": primaryOutward.availableQuantity - calculatedTotalQuantity
        }
      },
      { new: true, session, runValidators: true }
    );

    await session.commitTransaction();

    const response = generateResponse(
      "Success",
      "Transfer from primary outward to secondary inward completed successfully",
      updatedDoc
    );

    res.status(200).json(response);
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});

const secondaryInwardToSecondaryOutward = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;
  const {
    secondaryInwardId,  // Added source ID
    secondaryOutwardDate,
    numberOfBottles,
    size,
    cavity,
    numberOfTrays,
    pollyhouse,
    laboursEngaged,
    remarks
  } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Validate required fields
    if (!secondaryInwardId || !secondaryOutwardDate || !numberOfBottles || !size || !cavity || !numberOfTrays || !pollyhouse) {
      throw new AppError("Missing required fields", 400);
    }

    const plantOutward = await PlantOutward.findOne({ batchId }).session(session);
    if (!plantOutward) {
      throw new AppError("No plant outward found with this batch ID", 404);
    }

    // Find and validate secondary inward entry
    const secondaryInward = plantOutward.secondaryInward.id(secondaryInwardId);
    if (!secondaryInward) {
      throw new AppError("Secondary inward entry not found", 404);
    }

    const calculatedTotalQuantity = cavity * numberOfTrays;

    // Validate transfer
    try {
      plantOutward.validateTransfer('secondaryInward', secondaryInwardId, calculatedTotalQuantity);
    } catch (error) {
      throw new AppError(error.message, 400);
    }

    // Create transfer history for secondary inward
    const transferHistory = {
      transferDate: secondaryOutwardDate,
      quantityTransferred: calculatedTotalQuantity,
      remarks
    };

    // Create secondary outward entry
    const secondaryOutwardEntry = {
      secondaryOutwardDate,
      numberOfBottles,
      size,
      cavity,
      numberOfTrays,
      totalQuantity: calculatedTotalQuantity,
      availableQuantity: calculatedTotalQuantity,
      pollyhouse,
      laboursEngaged,
      transferStatus: 'available',
      sourceSecondaryInwardId: secondaryInwardId
    };

    const newSecondaryInwardStatus = 
      secondaryInward.availableQuantity - calculatedTotalQuantity === 0 ? 
      'fully_transferred' : 'partially_transferred';

    const updatedDoc = await PlantOutward.findOneAndUpdate(
      { batchId, "secondaryInward._id": secondaryInwardId },
      {
        $push: {
          secondaryOutward: secondaryOutwardEntry,
          "secondaryInward.$.transferHistory": transferHistory
        },
        $set: {
          "secondaryInward.$.transferStatus": newSecondaryInwardStatus,
          "secondaryInward.$.availableQuantity": secondaryInward.availableQuantity - calculatedTotalQuantity
        }
      },
      { new: true, session, runValidators: true }
    );

    await session.commitTransaction();

    const response = generateResponse(
      "Success",
      "Transfer from secondary inward to secondary outward completed successfully",
      updatedDoc
    );

    res.status(200).json(response);
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});

// Updated getTransferHistory to include all stages
const getTransferHistory = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;
  const { stage, startDate, endDate } = req.query;

  const plantOutward = await PlantOutward.findOne({ batchId });
  if (!plantOutward) {
    throw new AppError("No plant outward found with this batch ID", 404);
  }

  let transfers = [];

  // Get lab to primary transfers
  if (!stage || stage === "lab") {
    const labTransfers = plantOutward.outward.flatMap(lab => 
      lab.transferHistory.map(t => ({
        ...t.toObject(),
        fromStage: "lab",
        toStage: "primary_inward",
        size: lab.size
      }))
    );
    transfers = [...transfers, ...labTransfers];
  }

  // Get primary inward to outward transfers
  if (!stage || stage === "primary_inward") {
    const primaryInwardTransfers = plantOutward.primaryInward.flatMap(primary => 
      primary.transferHistory.map(t => ({
        ...t.toObject(),
        fromStage: "primary_inward",
        toStage: "primary_outward",
        size: primary.size
      }))
    );
    transfers = [...transfers, ...primaryInwardTransfers];
  }

  // Get primary outward to secondary transfers
  if (!stage || stage === "primary_outward") {
    const primaryOutwardTransfers = plantOutward.primaryOutward.flatMap(primary => 
      primary.transferHistory.map(t => ({
        ...t.toObject(),
        fromStage: "primary_outward",
        toStage: "secondary_inward",
        size: primary.size
      }))
    );
    transfers = [...transfers, ...primaryOutwardTransfers];
  }

  // Get secondary inward to outward transfers
  if (!stage || stage === "secondary_inward") {
    const secondaryInwardTransfers = plantOutward.secondaryInward.flatMap(secondary => 
      secondary.transferHistory.map(t => ({
        ...t.toObject(),
        fromStage: "secondary_inward",
        toStage: "secondary_outward",
        size: secondary.size
      }))
    );
    transfers = [...transfers, ...secondaryInwardTransfers];
  }

  // Apply date filters if provided
  if (startDate && endDate) {
    transfers = transfers.filter(
      t => t.transferDate >= new Date(startDate) && 
           t.transferDate <= new Date(endDate)
    );
  }

  // Sort by date
  transfers.sort((a, b) => b.transferDate - a.transferDate);

  const response = generateResponse(
    "Success",
    "Transfer history retrieved successfully",
    transfers
  );

  res.status(200).json(response);
});

const getPrimaryInwards = catchAsync(async (req, res, next) => {
  const { batchId, startDate, endDate } = req.query;

  // Initialize query object
  const queryObj = {};

  // Add batchId filter if provided
  if (batchId) {
    queryObj.batchId = batchId;
  }

  // Add date range filter if provided
  if (startDate && endDate) {
    queryObj["primaryInward"] = {
      $elemMatch: {
        primaryInwardDate: {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        }
      }
    };
  }

  const plantOutwards = await PlantOutward.find(queryObj)
    .populate("batchId", "batchNumber dateAdded")
    .select("primaryInward")
    .sort("-createdAt");

  // Extract only primaryInward data
  const primaryInwards = plantOutwards.flatMap(po => po.primaryInward);

  const response = generateResponse(
    "Success",
    "Primary inward entries retrieved successfully",
    primaryInwards,
    undefined
  );

  res.status(200).json(response);
});

const getPrimaryOutwards = catchAsync(async (req, res, next) => {
  const { batchId, startDate, endDate, isReceived } = req.query;

  // Initialize query object
  const queryObj = {};

  // Add batchId filter if provided
  if (batchId) {
    queryObj.batchId = batchId;
  }

  // Add date range filter if provided
  if (startDate && endDate) {
    queryObj["primaryOutward"] = {
      $elemMatch: {
        primaryOutwardDate: {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        }
      }
    };
  }

  // Add isReceived filter if provided
  if (isReceived !== undefined) {
    queryObj["primaryOutward.isReceived"] = isReceived === 'true';
  }

  const plantOutwards = await PlantOutward.find(queryObj)
    .populate("batchId", "batchNumber dateAdded")
    .select("primaryOutward")
    .sort("-createdAt");

  // Extract only primaryOutward data
  const primaryOutwards = plantOutwards.flatMap(po => po.primaryOutward);

  const response = generateResponse(
    "Success",
    "Primary outward entries retrieved successfully",
    primaryOutwards,
    undefined
  );

  res.status(200).json(response);
});

const getSecondaryInwards = catchAsync(async (req, res, next) => {
  const { batchId, startDate, endDate } = req.query;

  // Initialize query object
  const queryObj = {};

  // Add batchId filter if provided
  if (batchId) {
    queryObj.batchId = batchId;
  }

  // Add date range filter if provided
  if (startDate && endDate) {
    queryObj["secondaryInward"] = {
      $elemMatch: {
        secondaryInwardDate: {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        }
      }
    };
  }

  const plantOutwards = await PlantOutward.find(queryObj)
    .populate("batchId", "batchNumber dateAdded")
    .select("secondaryInward")
    .sort("-createdAt");

  // Extract only secondaryInward data
  const secondaryInwards = plantOutwards.flatMap(po => po.secondaryInward);

  const response = generateResponse(
    "Success",
    "Secondary inward entries retrieved successfully",
    secondaryInwards,
    undefined
  );

  res.status(200).json(response);
});

const getSecondaryOutwards = catchAsync(async (req, res, next) => {
  const { batchId, startDate, endDate } = req.query;

  // Initialize query object
  const queryObj = {};

  // Add batchId filter if provided
  if (batchId) {
    queryObj.batchId = batchId;
  }

  // Add date range filter if provided
  if (startDate && endDate) {
    queryObj["secondaryOutward"] = {
      $elemMatch: {
        secondaryOutwardDate: {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        }
      }
    };
  }

  const plantOutwards = await PlantOutward.find(queryObj)
    .populate("batchId", "batchNumber dateAdded")
    .select("secondaryOutward")
    .sort("-createdAt");

  // Extract only secondaryOutward data
  const secondaryOutwards = plantOutwards.flatMap(po => po.secondaryOutward);

  const response = generateResponse(
    "Success",
    "Secondary outward entries retrieved successfully",
    secondaryOutwards,
    undefined
  );

  res.status(200).json(response);
});

const getPrimaryInwardById = catchAsync(async (req, res, next) => {
  const { batchId, primaryInwardId } = req.params;

  const plantOutward = await PlantOutward.findOne({
    batchId,
    "primaryInward._id": primaryInwardId
  }).populate("batchId", "batchNumber dateAdded");

  if (!plantOutward) {
    return next(new AppError("No plant outward found with this batch ID", 404));
  }

  const primaryInward = plantOutward.primaryInward.id(primaryInwardId);
  if (!primaryInward) {
    return next(new AppError("Primary inward entry not found", 404));
  }

  const response = generateResponse(
    "Success",
    "Primary inward entry retrieved successfully",
    primaryInward,
    undefined
  );

  res.status(200).json(response);
});

const getPrimaryOutwardById = catchAsync(async (req, res, next) => {
  const { batchId, primaryOutwardId } = req.params;

  const plantOutward = await PlantOutward.findOne({
    batchId,
    "primaryOutward._id": primaryOutwardId
  }).populate("batchId", "batchNumber dateAdded");

  if (!plantOutward) {
    return next(new AppError("No plant outward found with this batch ID", 404));
  }

  const primaryOutward = plantOutward.primaryOutward.id(primaryOutwardId);
  if (!primaryOutward) {
    return next(new AppError("Primary outward entry not found", 404));
  }

  const response = generateResponse(
    "Success",
    "Primary outward entry retrieved successfully",
    primaryOutward,
    undefined
  );

  res.status(200).json(response);
});

const getSecondaryInwardById = catchAsync(async (req, res, next) => {
  const { batchId, secondaryInwardId } = req.params;

  const plantOutward = await PlantOutward.findOne({
    batchId,
    "secondaryInward._id": secondaryInwardId
  }).populate("batchId", "batchNumber dateAdded");

  if (!plantOutward) {
    return next(new AppError("No plant outward found with this batch ID", 404));
  }

  const secondaryInward = plantOutward.secondaryInward.id(secondaryInwardId);
  if (!secondaryInward) {
    return next(new AppError("Secondary inward entry not found", 404));
  }

  const response = generateResponse(
    "Success",
    "Secondary inward entry retrieved successfully",
    secondaryInward,
    undefined
  );

  res.status(200).json(response);
});

const getSecondaryOutwardById = catchAsync(async (req, res, next) => {
  const { batchId, secondaryOutwardId } = req.params;

  const plantOutward = await PlantOutward.findOne({
    batchId,
    "secondaryOutward._id": secondaryOutwardId
  }).populate("batchId", "batchNumber dateAdded");

  if (!plantOutward) {
    return next(new AppError("No plant outward found with this batch ID", 404));
  }

  const secondaryOutward = plantOutward.secondaryOutward.id(secondaryOutwardId);
  if (!secondaryOutward) {
    return next(new AppError("Secondary outward entry not found", 404));
  }

  const response = generateResponse(
    "Success",
    "Secondary outward entry retrieved successfully",
    secondaryOutward,
    undefined
  );

  res.status(200).json(response);
});

export {
  addLabEntry,
  updateLabEntry,
  getPlantOutwardByBatchId,
  getAllPlantOutwards,
  addPrimaryInward,
  updatePrimaryInward,
  deletePrimaryInward,
  getPrimaryInwardByBatchId,
  labToPrimaryInward,
  primaryInwardToPrimaryOutward,
  primaryToSecondaryInward,
  secondaryInwardToSecondaryOutward,
  getTransferHistory,
  getPrimaryInwards,
  getPrimaryOutwards,
  getSecondaryInwards,
  getSecondaryOutwards,
  getPrimaryInwardById,
  getPrimaryOutwardById,
  getSecondaryInwardById,
  getSecondaryOutwardById
};
