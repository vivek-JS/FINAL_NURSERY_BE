import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import APIFeatures from "../utility/apiFeatures.js";

const createOne = (Model, modelName) =>
  catchAsync(async (req, res, next) => {
    // Extract `payment` from the request body if the model is "Order"
    if (modelName === "Order") {
      const { payment, ...orderData } = req.body; // Separate `payment` from other order data

      if (payment) {
        // Ensure `payment` is an array and validate its structure
        const formattedPayments = Array.isArray(payment)
          ? payment.map((pay) => ({
              paidAmount: pay.paidAmount,
              paymentStatus: pay.paymentStatus || false,
              paymentDate: pay.paymentDate,
              bankName: pay.bankName,
              receiptPhoto: pay.receiptPhoto || [],
              modeOfPayment: pay.modeOfPayment,
            }))
          : [];

        // Assign `payment` to `orderData.payment`
        orderData.payment = formattedPayments;
      }

      // Merge processed `orderData` back into `req.body`
      req.body = { ...orderData };
    }

    // Create the document
    const doc = await Model.create(req.body);

    // Hide sensitive data if applicable
    if (doc.password) doc.password = undefined;

    // Generate a response
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
    console.log("Request Body:", req.body);  // Log the body to check the data

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
      // Fetch orders with populated fields for farmer and plantName
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
          select: "name subtypes", // Fetch `name` and `subtypes` of PlantCms
        });

      const doc = await query.lean();

      // Add the plantSubtype name manually
      const enrichedDoc = doc.map((order) => {
        const plantName = order.plantName?.name || null;
        const plantSubtype = order.plantName?.subtypes.find(
          (subtype) => subtype._id.toString() === order.plantSubtype.toString()
        )?.name;

        return {
          ...order,
          plantName,
          plantSubtype,
        };
      });

      // Apply regex-based filtering on populated data if search is provided
      const filteredDoc = search
        ? enrichedDoc.filter((order) => {
            const farmerName = order.farmer?.name || "";
            const farmerMobile = order.farmer?.mobileNumber || "";

            // Check if search term matches either name or mobile number, case-insensitive
            const searchRegex = new RegExp(search, "i");
            return searchRegex.test(farmerName) || searchRegex.test(farmerMobile);
          })
        : enrichedDoc;

      // Sort results based on the provided key
      const sortedDoc = filteredDoc.sort((a, b) => {
        if (a[sortKey] < b[sortKey]) return -1 * order;
        if (a[sortKey] > b[sortKey]) return 1 * order;
        return 0;
      });

      // Transform documents to include both `id` and `_id`
      const transformedDoc = sortedDoc.map((item) => {
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

    // For other models, no need for specific population/filtering
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
