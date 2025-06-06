import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import APIFeatures from "../utility/apiFeatures.js";
import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";

const updateSlot = async (bookingSlot, numberOfPlants, action = "subtract") => {
  console.log(`[updateSlot] START - Action: ${action}, Slot: ${bookingSlot}, Plants: ${numberOfPlants}`);

  // Step 1: If subtracting, first check if enough plants are available
  if (action === "subtract") {
    const currentSlot = await PlantSlot.findOne(
      { "subtypeSlots.slots._id": bookingSlot },
      { "subtypeSlots.$": 1 }
    );

    if (!currentSlot || !currentSlot.subtypeSlots[0]) {
      console.error("[updateSlot] ERROR: Slot not found");
      throw new Error("Slot not found");
    }

    const targetSlot = currentSlot.subtypeSlots[0].slots.find(
      slot => slot._id.toString() === bookingSlot.toString()
    );

    if (!targetSlot) {
      console.error("[updateSlot] ERROR: Specific slot not found");
      throw new Error("Specific slot not found");
    }

    if (targetSlot.totalPlants < numberOfPlants) {
      console.error(`[updateSlot] ERROR: Not enough plants available. Requested: ${numberOfPlants}, Available: ${targetSlot.totalPlants}`);
      throw new Error(`Not enough plants available. Only ${targetSlot.totalPlants} plants available.`);
    }
  }

  // Step 2: Build the update operation based on the action
  const updateOperation = {};
  if (action === "subtract") {
    updateOperation["subtypeSlots.$[subtypeSlot].slots.$[slot].totalPlants"] = -numberOfPlants; // Decrease totalPlants
    updateOperation["subtypeSlots.$[subtypeSlot].slots.$[slot].totalBookedPlants"] = numberOfPlants; // Increase totalBookedPlants
  } else if (action === "add") {
    updateOperation["subtypeSlots.$[subtypeSlot].slots.$[slot].totalPlants"] = numberOfPlants; // Increase totalPlants
    updateOperation["subtypeSlots.$[subtypeSlot].slots.$[slot].totalBookedPlants"] = -numberOfPlants; // Decrease totalBookedPlants
  }

  // Step 3: Perform an atomic update in the database using $inc
  const updateResult = await PlantSlot.updateOne(
    { "subtypeSlots.slots._id": bookingSlot },
    {
      $inc: {
        "subtypeSlots.$[subtypeSlot].slots.$[slot].totalPlants": updateOperation["subtypeSlots.$[subtypeSlot].slots.$[slot].totalPlants"],
        "subtypeSlots.$[subtypeSlot].slots.$[slot].totalBookedPlants": updateOperation["subtypeSlots.$[subtypeSlot].slots.$[slot].totalBookedPlants"],
      },
    },
    {
      arrayFilters: [
        { "subtypeSlot.slots._id": bookingSlot }, // Filter for the correct subtypeSlot
        { "slot._id": bookingSlot }, // Filter for the correct slot
      ],
    }
  );

  console.log(`[updateSlot] Update Result: ${JSON.stringify(updateResult)}`);

  // Step 4: Check if the update was successful
  if (updateResult.matchedCount === 0) {
    console.error("[updateSlot] ERROR: Slot not found or update failed");
    throw new Error("Failed to update the PlantSlot details");
  }

  console.log("[updateSlot] SUCCESS: Slot updated successfully");
  return updateResult; // Return the update result for reference
};



const createOne = (Model, modelName) =>
  catchAsync(async (req, res, next) => {
    if (modelName === "Order") {
      const { payment, bookingSlot, numberOfPlants, ...orderData } = req.body;

      if (!bookingSlot || !numberOfPlants) {
        return res.status(400).json({
          message: "bookingSlot and numberOfPlants are required",
        });
      }

      // Using session for transaction
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Step 1: Find the highest orderId
        const lastOrder = await Model.findOne()
          .sort({ orderId: -1 })
          .select("orderId");

        const orderId = lastOrder ? lastOrder.orderId + 1 : 1;

        // Step 2: Update the slot
        try {
          await updateSlot(bookingSlot, numberOfPlants, "subtract");
        } catch (slotError) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({ 
            message: slotError.message || "Failed to update slot"
          });
        }

        // Step 3: Create the Order
        const order = await Model.create([{
          ...orderData,
          bookingSlot,
          numberOfPlants,
          orderId,
        }], { session });

        await session.commitTransaction();
        session.endSession();

        const response = generateResponse(
          "Success",
          `${modelName} created successfully and slot updated`,
          order[0],
          undefined
        );

        return res.status(201).json(response);

      } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("[createOne] Error:", error.message);
        return res.status(400).json({ message: error.message });
      }
    }

    const doc = await Model.create(req.body);
    if (doc.password) doc.password = undefined;

    const response = generateResponse(
      "Success",
      `${modelName} created successfully`,
      doc,
      undefined
    );

    return res.status(201).json(response);
  });

  const { isValidObjectId } = mongoose;
  
  const updateOne = (Model, modelName, allowedFields) =>
  catchAsync(async (req, res, next) => {
    const { id } = req.body;

    if (!isValidObjectId(id)) {
      return next(new AppError('Invalid ID format', 400));
    }

    if (modelName !== "Order") {
      const doc = await Model.findByIdAndUpdate(id, req.body, {
        new: true,
        runValidators: true
      });

      if (!doc) {
        return next(new AppError("No document found with that ID", 404));
      }

      return res.status(200).json(
        generateResponse("Success", `${modelName} updated successfully`, doc)
      );
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const existingDoc = await Model.findById(id).session(session);
      if (!existingDoc) {
        throw new AppError("No document found with that ID", 404);
      }

      const filteredBody = Object.keys(req.body)
        .filter(key => allowedFields.includes(key))
        .reduce((obj, key) => {
          obj[key] = req.body[key];
          return obj;
        }, {});

      if (filteredBody.bookingSlot || filteredBody.numberOfPlants) {
        try {
          await handleSlotUpdates(existingDoc, filteredBody);
        } catch (error) {
          await session.abortTransaction();
          session.endSession();
          return next(error);
        }
      }

      const updatedDoc = await Model.findOneAndUpdate(
        { 
          _id: id,
          __v: existingDoc.__v 
        },
        {
          ...filteredBody,
          $inc: { __v: 1 }
        },
        {
          new: true,
          runValidators: true,
          session
        }
      );

      if (!updatedDoc) {
        throw new AppError("Document was modified by another process. Please try again.", 409);
      }

      await session.commitTransaction();
      session.endSession();

      return res.status(200).json(
        generateResponse("Success", `${modelName} updated successfully`, updatedDoc)
      );

    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      return next(error);
    }
  });
  
  // Helper function to handle slot updates
  const handleSlotUpdates = async (existingDoc, filteredBody) => {
    const { bookingSlot, numberOfPlants } = filteredBody;
  
    try {
      // Check slot availability before any updates
      const checkSlotAvailability = async (slotId, plantsNeeded) => {
        const currentSlot = await PlantSlot.findOne(
          { "subtypeSlots.slots._id": slotId },
          { "subtypeSlots.$": 1 }
        );
  
        if (!currentSlot?.subtypeSlots?.[0]?.slots) {
          throw new AppError("Slot not found", 404);
        }
  
        const slot = currentSlot.subtypeSlots[0].slots.find(
          s => s._id.toString() === slotId.toString()
        );
  
        if (!slot) {
          throw new AppError("Specific slot not found", 404);
        }
  
        if (slot.totalPlants < plantsNeeded) {
          throw new AppError(`Not enough plants available in slot. Only ${slot.totalPlants} plants available.`, 400);
        }
      };
  
      if (bookingSlot && bookingSlot.toString() !== existingDoc.bookingSlot.toString()) {
        // Check new slot availability before switching
        await checkSlotAvailability(bookingSlot, numberOfPlants || existingDoc.numberOfPlants);
        
        await Promise.all([
          updateSlot(existingDoc.bookingSlot, existingDoc.numberOfPlants, "add"),
          updateSlot(bookingSlot, numberOfPlants || existingDoc.numberOfPlants, "subtract")
        ]);
      } else if (numberOfPlants) {
        const quantityDifference = numberOfPlants - existingDoc.numberOfPlants;
        if (quantityDifference > 0) {
          // Only check availability if increasing quantity
          await checkSlotAvailability(existingDoc.bookingSlot, quantityDifference);
        }
        
        if (quantityDifference !== 0) {
          await updateSlot(
            existingDoc.bookingSlot,
            Math.abs(quantityDifference),
            quantityDifference < 0 ? "add" : "subtract"
          );
        }
      }
    } catch (error) {
      throw new AppError(error.message || "Failed to update booking slots", error.statusCode || 500);
    }
  };

const updateOneNestedData = (Model, modelName) =>
  catchAsync(async (req, res, next) => {
    const { id, ...updateData } = req.body;

    // Find the document by ID
    let doc = await Model.findById(id);

    if (!doc) {
      return next(new AppError(`No document found with that ID`, 404));
    }

    // Update nested properties based on updateData keys
    for (let key in updateData) {
      doc[key] = updateData[key];
    }

    // Save the updated document
    doc = await doc.save();

    const response = generateResponse(
      "Success",
      `${modelName} updated successfully`,
      doc,
      undefined
    );

    return res.status(200).json(response);
  });

const updateOneAndPushElement = (Model, modelName) =>
  catchAsync(async (req, res, next) => {
    const { id, paymentAmount } = req.body;

    const updateObj = { ...req.body };

    if (paymentAmount !== undefined) {
      updateObj.$push = { payment: { paidAmount: paymentAmount } };
    }

    const doc = await Model.findByIdAndUpdate(id, updateObj, {
      new: true,
      runValidators: true,
    });

    if (!doc) {
      return next(new AppError(`No ${modelName} found with that ID`, 404));
    }

    const response = generateResponse(
      "Success",
      `${modelName} updated successfully`,
      doc,
      undefined
    );

    return res.status(200).json(response);
  });

const deleteOne = (Model, modelName) =>
  catchAsync(async (req, res, next) => {
    const doc = await Model.findByIdAndDelete(req.body.id);

    if (!doc) {
      return next(new AppError("No document found with that ID", 404));
    }

    const response = generateResponse(
      "Success",
      `${modelName} deleted successfully`,
      undefined,
      undefined
    );

    return res.status(204).json(response);
  });

const getOne = (Model, modelName, popOptions) =>
  catchAsync(async (req, res, next) => {
    let query = Model.findById(req.params.id);
    if (popOptions) query = query.populate(popOptions);
    const doc = await query;

    if (!doc) {
      return next(new AppError("No document found with that ID", 404));
    }

    const response = generateResponse(
      "Success",
      `${modelName} found successfully`,
      doc,
      undefined
    );

    return res.status(200).json(response);
  });

  const getAll = (Model, modelName) =>
  catchAsync(async (req, res, next) => {
    if (modelName !== "Order") {
      let filter = {};

      let query = Model.find(filter);

      const features = new APIFeatures(query, req.query, modelName)
        .filter()
        .sort()
        .limitFields()
        .paginate();  

      const doc = await features.query.lean();

      const transformedDoc = doc.map((item) => {
        const { _id, ...rest } = item;
        return { id: _id, _id: _id, ...rest };
      });

      const response = generateResponse(
        "Success",
        `${modelName} found successfully`,
        transformedDoc,
        undefined
      );

      return res.status(200).json(response);
    }

    const {
      sortKey = "createdAt",
      sortOrder = "desc",
      search,
      startDate,
      endDate,
      dispatched = false, // New parameter
      salesPerson, // Added salesPerson parameter
      page = 1,
      limit = 100,
      status
    } = req.query;

    const order = sortOrder.toLowerCase() === "desc" ? -1 : 1;
    const skip = (page - 1) * limit;

    // Build the aggregation pipeline
    const pipeline = [];

    // Apply salesPerson filter if present
    if (salesPerson) {
      pipeline.push({
        $match: { salesPerson: new mongoose.Types.ObjectId(salesPerson) },
      });
    }
    if (status) {
      // Convert comma-separated string to array and handle single status case
      const statusArray = status.split(',').map(s => s.trim());
      pipeline.push({
        $match: { 
          orderStatus: { $in: statusArray }
        }
      });
    }
    
    // Apply Date range filtering only when `search` is NOT present
    if (!search && startDate && endDate && dispatched === "false") {
      const parseDate = (dateStr, isEnd = false) => {
        const [day, month, year] = dateStr.split("-");
        return isEnd
          ? new Date(`${year}-${month}-${day}T23:59:59.999Z`)
          : new Date(`${year}-${month}-${day}T00:00:00.000Z`);
      };

      const start = parseDate(startDate);
      const end = parseDate(endDate, true);
      pipeline.push({ $match: { createdAt: { $gte: start, $lte: end } } });
    }

    // Search filtering by `orderId` or `farmer.name`
    if (search) {
      const searchRegex = new RegExp(search, "i");
      pipeline.push({
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      });

      pipeline.push({
        $match: {
          $or: [
            { orderId: search }, // Match orderId
            { "farmer.name": searchRegex }, // Match farmer name
          ],
        },
      });
    } else {
      // Lookup farmer data if search is not present (so farmer data is always included)
      pipeline.push({
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      });
    }

    // Lookup related data
    pipeline.push(
      {
        $lookup: {
          from: "plantcms",
          localField: "plantName",
          foreignField: "_id",
          as: "plantName",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "salesPerson",
          foreignField: "_id",
          as: "salesPerson",
        },
      },
      {
        $lookup: {
          from: "plantslots",
          let: { bookingSlotId: "$bookingSlot" },
          pipeline: [
            { $unwind: "$subtypeSlots" },
            { $unwind: "$subtypeSlots.slots" },
            {
              $match: {
                $expr: { $eq: ["$subtypeSlots.slots._id", "$$bookingSlotId"] },
              },
            },
            {
              $project: {
                _id: 0,
                slotId: "$subtypeSlots.slots._id", // Include the slot _id
                startDay: "$subtypeSlots.slots.startDay",
                endDay: "$subtypeSlots.slots.endDay",
                subtypeId: "$subtypeSlots.subtypeId",
                month: "$subtypeSlots.slots.month",
              },
            },
          ],
          as: "bookingSlotDetails",
        },
      }
    );

    // Add condition for dispatched = true
    if (dispatched === "true" && startDate && endDate) {
      pipeline.push(
        {
          $addFields: {
            parsedStartDay: {
              $toDate: {
                $dateFromString: {
                  dateString: { $arrayElemAt: ["$bookingSlotDetails.startDay", 0] },
                  format: "%d-%m-%Y",
                },
              },
            },
            parsedEndDay: {
              $toDate: {
                $dateFromString: {
                  dateString: { $arrayElemAt: ["$bookingSlotDetails.endDay", 0] },
                  format: "%d-%m-%Y",
                },
              },
            },
            queryStartDate: {
              $toDate: {
                $dateFromString: { dateString: startDate, format: "%d-%m-%Y" },
              },
            },
            queryEndDate: {
              $toDate: {
                $dateFromString: { dateString: endDate, format: "%d-%m-%Y" },
              },
            },
          },
        },
        {
          $match: {
            $expr: {
              $or: [
                {
                  $and: [
                    { $lte: ["$parsedStartDay", "$queryEndDate"] },
                    { $gte: ["$parsedStartDay", "$queryStartDate"] },
                  ],
                },
                {
                  $and: [
                    { $lte: ["$parsedEndDay", "$queryEndDate"] },
                    { $gte: ["$parsedEndDay", "$queryStartDate"] },
                  ],
                },
                {
                  $and: [
                    { $lte: ["$parsedStartDay", "$queryEndDate"] },
                    { $gte: ["$parsedEndDay", "$queryStartDate"] },
                  ],
                },
              ],
            },
          },
        }
      );
    }

    // Enrich plantSubtype details (name and ID)
    pipeline.push({
      $set: {
        plantSubtypeDetails: {
          $arrayElemAt: [
            {
              $filter: {
                input: { $arrayElemAt: ["$plantName.subtypes", 0] },
                as: "subtype",
                cond: { $eq: ["$$subtype._id", "$plantSubtype"] },
              },
            },
            0,
          ],
        },
      },
    });

    // Select required fields at the end
    pipeline.push(
      {
        $project: {
          farmer: {
            $arrayElemAt: [
              {
                $map: {
                  input: "$farmer",
                  as: "farmerData",
                  in: {
                    name: "$$farmerData.name",
                    mobileNumber: "$$farmerData.mobileNumber",
                    village: "$$farmerData.village",
                    taluka: "$$farmerData.taluka",
                    district: "$$farmerData.district",
                  },
                },
              },
              0,
            ],
          },
          plantType: {
            id: { $arrayElemAt: ["$plantName._id", 0] },
            name: { $arrayElemAt: ["$plantName.name", 0] },
          },
          plantSubtype: {
            id: "$plantSubtypeDetails._id",
            name: "$plantSubtypeDetails.name",
          },
          bookingSlot: "$bookingSlotDetails",
          salesPerson: {
            $arrayElemAt: [
              {
                $map: {
                  input: "$salesPerson",
                  as: "sales",
                  in: {
                    name: "$$sales.name",
                    phoneNumber: "$$sales.phoneNumber",
                  },
                },
              },
              0,
            ],
          },
          createdAt: 1,
          orderStatus: 1,
          payment: 1,
          numberOfPlants: 1,
          orderId: 1,
          rate: 1,
          farmReadyDate: 1  // Added farmReadyDate field

        },
      },
      { $sort: { [sortKey]: order } },
      { $skip: skip },
      { $limit: parseInt(limit, 10) }
    );

    // Execute the pipeline
    const results = await Model.aggregate(pipeline);

    // Transform documents for response
    const transformedResults = results.map((item) => {
      const { _id, ...rest } = item;
      return { id: _id, _id, ...rest };
    });

    const response = generateResponse(
      "Success",
      `${modelName} found successfully`,
      transformedResults,
      undefined
    );

    return res.status(200).json(response);
  });



const getCMS = (Model) =>
  catchAsync(async (req, res, next) => {
    const { name, entity } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    let data;

    if (name && name !== "") {
      data = await Model.find({
        data: { $regex: `^${name}`, $options: "i" },
        type: entity,
      })
        .skip(skip)
        .limit(100)
        .select("-_id -type -__v");
    } else {
      data = await Model.find({ type: entity })
        .skip(skip)
        .limit(100)
        .select("-_id -type -__v");
    }

    const formattedData = data.map((item) => item.data);

    res.status(200).send(formattedData);
  });

const createCMS = (Model, entity) =>
  catchAsync(async (req, res, next) => {
    const data = await Model.find({
      data: req.body[entity],
      type: entity,
    });

    if (data.length <= 0) {
      await new Model({
        data: req.body[entity],
        type: entity,
      }).save();
    }

    next();
  });

const isPhoneNumberExists = (Model, modelName) =>
  catchAsync(async (req, _, next) => {
    const { phoneNumber } = req.body;

    const isFound = await Model.findOne({ phoneNumber });

    if (isFound) {
      throw new AppError(
        `${modelName} with same phone number address already exists`,
        409
      );
    }
    next();
  });

const isDisabled = (Model, modelName) =>
  catchAsync(async (req, _, next) => {
    const { phoneNumber } = req.body;
console.log(phoneNumber)
    const data = await Model.findOne({ phoneNumber });
console.log(data)
    if (data.isDisabled) {
      throw new AppError(`Your access to this app is disabled`, 409);
    }
    next();
  });

export {
  createOne,
  deleteOne,
  updateOne,
  updateOneAndPushElement,
  getOne,
  getAll,
  getCMS,
  createCMS,
  updateOneNestedData,
  isPhoneNumberExists,
  isDisabled,
};
