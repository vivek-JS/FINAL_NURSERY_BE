import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import APIFeatures from "../utility/apiFeatures.js";
import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";

const updateSlot = async (bookingSlot, numberOfPlants, action = "subtract") => {
  console.log(`[updateSlot] START - Action: ${action}, Slot: ${bookingSlot}, Plants: ${numberOfPlants}`);

  // Step 1: Fetch the slot
  const plantSlots = await PlantSlot.find({
    "subtypeSlots.slots._id": bookingSlot,
  });

  let slot = null;

  for (const plantSlot of plantSlots) {
    for (const subtypeSlot of plantSlot.subtypeSlots) {
      slot = subtypeSlot.slots.find(
        (s) => s._id?.toString() === bookingSlot.toString()
      );
      if (slot) break;
    }
    if (slot) break;
  }

  if (!slot) {
    console.error("[updateSlot] ERROR: Slot not found");
    throw new Error("PlantSlot not found for the given bookingSlot");
  }

  console.log(`[updateSlot] Found Slot - Total Plants: ${slot.totalPlants}, Booked Plants: ${slot.totalBookedPlants}`);

  // Step 2: Update slot details
  if (action === "subtract") {
    if (slot.totalPlants < numberOfPlants) {
      console.error("[updateSlot] ERROR: Insufficient plants in slot");
      throw new Error("Not enough plants available in the selected slot");
    }
    slot.totalPlants -= numberOfPlants;
    slot.totalBookedPlants += numberOfPlants;
  } else if (action === "add") {
    slot.totalPlants += numberOfPlants;
    slot.totalBookedPlants -= numberOfPlants;
  }

  console.log(`[updateSlot] Updated Slot - Total Plants: ${slot.totalPlants}, Booked Plants: ${slot.totalBookedPlants}`);

  // Step 3: Persist changes
  const updateResult = await PlantSlot.updateOne(
    { "subtypeSlots.slots._id": bookingSlot },
    {
      $set: {
        "subtypeSlots.$[subtypeSlot].slots.$[slot].totalPlants": slot.totalPlants,
        "subtypeSlots.$[subtypeSlot].slots.$[slot].totalBookedPlants": slot.totalBookedPlants,
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

  if (updateResult.modifiedCount === 0) {
    console.error("[updateSlot] ERROR: Failed to update slot");
    throw new Error("Failed to update the PlantSlot details");
  }

  console.log("[updateSlot] SUCCESS: Slot updated successfully");
  return slot; // Return updated slot for reference
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

      try {
        // Step 1: Generate orderId
        const currentMonth = new Date().getMonth() + 1; // Get current month (1-based)
        const monthPrefix = currentMonth.toString().padStart(2, "0"); // Ensure it's 2 digits
        const lastOrder = await Model.findOne({ orderId: { $regex: `^${monthPrefix}` } })
          .sort({ orderId: -1 })
          .select("orderId");
        const orderIndex = lastOrder
          ? parseInt(lastOrder.orderId.slice(2)) + 1
          : 1; // Extract and increment index, or start at 1
        const orderId = `${monthPrefix}${orderIndex}`;

        // Step 2: Create the Order
        const order = await Model.create({
          ...orderData,
          bookingSlot,
          numberOfPlants,
          orderId,
        });

        // Step 3: Update the slot
        await updateSlot(bookingSlot, numberOfPlants, "subtract");

        const response = generateResponse(
          "Success",
          `${modelName} created successfully and slot updated`,
          order,
          undefined
        );

        return res.status(201).json(response);
      } catch (error) {
        console.error("[createOne] Error:", error.message);

        // If an order was partially created, roll it back
        if (error.name !== "ValidationError") {
          await Model.deleteOne({ orderId });
        }

        return res.status(400).json({ message: error.message });
      }
    }

    // Generic case for other models
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





const updateOne = (Model, modelName) =>
  catchAsync(async (req, res, next) => {
    // Find by id  and update

    const doc = await Model.findByIdAndUpdate(req.body.id, req.body, {
      new: true,
    });

    // If doc not found
    if (!doc) {
      return next(new AppError("No document found with that ID", 404));
    }

    const response = generateResponse(
      "Success",
      `${modelName} updated successfully`,
      doc,
      undefined
    );

    return res.status(200).json(response);
  });

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
    const {
      sortKey = "createdAt",
      sortOrder = "desc",
      search,
      startDate,
      endDate,
      page = 1,
      limit = 10,
    } = req.query;

    const order = sortOrder.toLowerCase() === "desc" ? -1 : 1;
    const skip = (page - 1) * limit;

    // Build the aggregation pipeline
    const pipeline = [];

    // Date range filtering
    if (startDate && endDate) {
      const parseDate = (dateStr, isEnd = false) => {
        const [day, month, year] = dateStr.split("-");
        return isEnd
          ? new Date(`${year}-${month}-${day}T23:59:59.999Z`) // End of the day
          : new Date(`${year}-${month}-${day}T00:00:00.000Z`); // Start of the day
      };
    
      const start = parseDate(startDate); // Start of the day
      const end = parseDate(endDate, true); // End of the day
      pipeline.push({ $match: { createdAt: { $gte: start, $lte: end } } });
    }
    

    // Search filtering
    if (search) {
      const searchRegex = new RegExp(search, "i");
      pipeline.push({
        $match: {
          $or: [
            { "farmer.name": searchRegex },
            { "farmer.mobileNumber": searchRegex },
          ],
        },
      });
    }

    // Lookup for related data
    pipeline.push(
      {
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      },
      { $unwind: "$farmer" },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantName",
          foreignField: "_id",
          as: "plantName",
        },
      },
      { $unwind: "$plantName" },
      {
        $lookup: {
          from: "users",
          localField: "salesPerson",
          foreignField: "_id",
          as: "salesPerson",
        },
      },
      { $unwind: "$salesPerson" },
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
                startDay: "$subtypeSlots.slots.startDay",
                endDay: "$subtypeSlots.slots.endDay",
                subtypeId: "$subtypeSlots.subtypeId",
                month: "$subtypeSlots.slots.month",


              },
            },
          ],
          as: "bookingSlotDetails",
        },
      },
      { $unwind: { path: "$bookingSlotDetails", preserveNullAndEmptyArrays: true } }
    );

    // Enrich plantSubtype name
    pipeline.push({
      $addFields: {
        plantSubtypeName: {
          $arrayElemAt: [
            {
              $filter: {
                input: "$plantName.subtypes",
                as: "subtype",
                cond: { $eq: ["$$subtype._id", "$plantSubtype"] },
              },
            },
            0,
          ],
        },
      },
    });

    // Select required fields
    pipeline.push({
      $project: {
        farmer: { name: 1, mobileNumber: 1, village: 1, taluka: 1, district: 1 },
        plantName: "$plantName.name",
        plantSubtype: "$plantSubtypeName.name",
        bookingSlot: "$bookingSlotDetails",
        salesPerson: { name: "$salesPerson.name", phoneNumber: "$salesPerson.phoneNumber" },
        createdAt: 1,
        orderStatus:1,
        payment:1,
        numberOfPlants:1,
        orderId:1

      },
    });

    // Sorting
    pipeline.push({ $sort: { [sortKey]: order } });

    // Pagination
    pipeline.push({ $skip: skip }, { $limit: parseInt(limit, 10) });

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

    const data = await Model.findOne({ phoneNumber });

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
