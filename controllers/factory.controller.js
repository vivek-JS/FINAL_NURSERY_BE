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

      // Step 1: Create the Order
      const order = await Model.create({ ...orderData, bookingSlot, numberOfPlants });

      try {
        // Step 2: Update the slot
        await updateSlot(bookingSlot, numberOfPlants, "subtract");

        const response = generateResponse(
          "Success",
          `${modelName} created successfully and slot updated`,
          order,
          undefined
        );

        return res.status(201).json(response);
      } catch (error) {
        // Rollback Order creation if slot update fails
        await Model.findByIdAndDelete(order._id);
        console.error("[createOne] Error updating slot:", error.message);
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
    let filter = {};
    const { sortKey = "createdAt", sortOrder = "desc", search } = req.query;
    const order = sortOrder.toLowerCase() === "desc" ? -1 : 1;

    if (modelName === "Order") {
      // Fetch orders with populated fields
      let query = Model.find(filter)
        .populate({
          path: "farmer",
          select: "name mobileNumber village taluka district",
          populate: {
            path: "district",
            select: "districts",
          },
        })
        .populate({
          path: "plantName",
          select: "name subtypes",
        })
        .populate({
          path: "salesPerson",
          select: "name phoneNumber", // Include salesPerson's name and phoneNumber
        });

      const orders = await query.lean();

      // Fetch `PlantSlot` details for the `bookingSlot`
      const plantSlotIds = orders.map((order) => order.bookingSlot);
      const plantSlots = await mongoose
        .model("PlantSlot")
        .find({ "subtypeSlots.slots._id": { $in: plantSlotIds } })
        .lean();

      // Map bookingSlot details to orders
      const enrichedOrders = orders.map((order) => {
        const plantName = order.plantName?.name || null;
        const plantSubtype = order.plantName?.subtypes.find(
          (subtype) => subtype._id?.toString() === order.plantSubtype?.toString()
        )?.name;

        // Find bookingSlot details
        let bookingSlotDetails = null;
        for (const plantSlot of plantSlots) {
          for (const subtypeSlot of plantSlot.subtypeSlots) {
            const slot = subtypeSlot.slots.find(
              (s) => s._id?.toString() === order.bookingSlot?.toString()
            );
            if (slot) {
              bookingSlotDetails = {
                ...slot,
                subtypeName: subtypeSlot.subtypeId.name, // Include subtype name
              };
              break;
            }
          }
          if (bookingSlotDetails) break;
        }

        return {
          ...order,
          plantName,
          plantSubtype,
          bookingSlot: bookingSlotDetails,
          salesPersonName: order.salesPerson?.name || null, // Add salesPerson name
          salesPersonPhoneNumber: order.salesPerson?.phoneNumber || null, // Add salesPerson phoneNumber
        };
      });

      // Apply regex-based filtering on populated data if search is provided
      const filteredOrders = search
        ? enrichedOrders.filter((order) => {
            const farmerName = order.farmer?.name || "";
            const farmerMobile = order.farmer?.mobileNumber || "";
            const searchRegex = new RegExp(search, "i");
            return searchRegex.test(farmerName) || searchRegex.test(farmerMobile);
          })
        : enrichedOrders;

      // Sort results based on the provided key
      const sortedOrders = filteredOrders.sort((a, b) => {
        if (a[sortKey] < b[sortKey]) return -1 * order;
        if (a[sortKey] > b[sortKey]) return 1 * order;
        return 0;
      });

      // Transform documents to include both `id` and `_id`
      const transformedOrders = sortedOrders.map((item) => {
        const { _id, ...rest } = item;
        return { id: _id, _id: _id, ...rest };
      });

      const response = generateResponse(
        "Success",
        `${modelName} found successfully`,
        transformedOrders,
        undefined
      );

      return res.status(200).json(response);
    }

    // For other models
    const features = new APIFeatures(Model.find(filter), req.query, modelName)
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
