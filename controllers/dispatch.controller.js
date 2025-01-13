import generateResponse from "../utility/responseFormat.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import Dispatch from "../models/dispatch.model.js";
import Order from "../models/order.model.js";
import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
// Helper to validate quantities
const validateQuantities = (plantsDetails) => {
  for (const plant of plantsDetails) {
    // Calculate total pickup quantity
    const pickupTotal = plant.pickupDetails.reduce(
      (sum, detail) => sum + detail.quantity,
      0
    );

    // Calculate total crate quantity
    const crateTotal = plant.crates.reduce(
      (sum, crate) => sum + crate.quantity,
      0
    );

    // Check if totals match plant quantity
    if (pickupTotal !== plant.quantity) {
      throw new AppError(
        `Pickup details total (${pickupTotal}) doesn't match plant quantity (${plant.quantity}) for ${plant.name}`,
        400
      );
    }
  }
};

// Generate unique transport ID
const generateTransportId = async () => {
  // Get total count of all dispatches
  const count = await Dispatch.countDocuments();
  // Simply add 1 to get the next ID
  return (count + 1).toString();
};

const createDispatch = catchAsync(async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const dispatchRequest = { ...req.body };

    // Modify each plant's details
    dispatchRequest.plantsDetails = dispatchRequest.plantsDetails.map(
      (plant) => ({
        ...plant,
        totalPlants: plant.pickupDetails.reduce(
          (sum, detail) => sum + detail.quantity,
          0
        ),
        crates: plant.crates.map((crate) => ({
          cavity: crate.cavity,
          cavityName: crate.cavityName,
          crateCount: crate.crateDetails.reduce(
            (sum, detail) => sum + detail.crateCount,
            0
          ),
          plantCount: crate.crateDetails.reduce(
            (sum, detail) => sum + detail.plantCount,
            0
          ),
          crateDetails: crate.crateDetails,
        })),
      })
    );

    validateQuantities(dispatchRequest.plantsDetails);
    dispatchRequest.transportId = await generateTransportId();

    const dispatch = await Dispatch.create([dispatchRequest], { session });

    await Order.updateMany(
      { _id: { $in: dispatchRequest.orderIds }, orderStatus: "FARM_READY" },
      { $set: { orderStatus: "DISPATCH_PROCESS" } },
      { session }
    );

    await session.commitTransaction();

    res
      .status(201)
      .json(
        generateResponse(
          "Success",
          "Dispatch created successfully and orders updated",
          dispatch[0]
        )
      );
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});
// Update dispatch controller

const updateDispatch = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  // If plants details are being updated, validate quantities
  if (req.body.plantsDetails) {
    validateQuantities(req.body.plantsDetails);
  }

  // Prevent updating transportId
  if (req.body.transportId) {
    delete req.body.transportId;
  }

  const dispatch = await Dispatch.findByIdAndUpdate(id, req.body, {
    new: true,
    runValidators: true,
  });

  if (!dispatch) {
    return next(new AppError("No dispatch found with that ID", 404));
  }

  const response = generateResponse(
    "Success",
    "Dispatch updated successfully",
    dispatch
  );

  res.status(200).json(response);
});

// Get dispatches controller
const getDispatches = catchAsync(async (req, res, next) => {
  const dispatches = await Dispatch.aggregate([
    // Filter out deleted documents
    {
      $match: { isDeleted: false },
    },
    // Initial sort by createdAt
    {
      $sort: { createdAt: -1 },
    },
    // Convert createdAt to date if not already
    {
      $addFields: {
        createdAt: { $toDate: "$createdAt" },
      },
    },
    // Expand the orderIds array
    {
      $unwind: "$orderIds",
    },
    // Lookup each order
    {
      $lookup: {
        from: "orders",
        localField: "orderIds",
        foreignField: "_id",
        as: "orderDetails",
      },
    },
    // Unwind the looked up order
    {
      $unwind: "$orderDetails",
    },
    // Lookup all related data for the order
    {
      $lookup: {
        from: "farmers",
        localField: "orderDetails.farmer",
        foreignField: "_id",
        as: "farmerDetails",
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "orderDetails.salesPerson",
        foreignField: "_id",
        as: "salesPersonDetails",
      },
    },
    {
      $lookup: {
        from: "plantcms",
        localField: "orderDetails.plantName",
        foreignField: "_id",
        as: "plantDetails",
      },
    },
    {
      $lookup: {
        from: "plantslots",
        let: { bookingSlotId: "$orderDetails.bookingSlot" },
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
              slotId: "$subtypeSlots.slots._id",
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
    // Group back all the data while preserving original dates
    {
      $group: {
        _id: "$_id",
        name: { $first: "$name" },
        transportId: { $first: "$transportId" },
        driverName: { $first: "$driverName" },
        vehicleName: { $first: "$vehicleName" },
        plantsDetails: { $first: "$plantsDetails" },
        returnedPlants: { $first: "$returnedPlants" },
        transportStatus: { $first: "$transportStatus" },
        createdAt: { $first: "$createdAt" }, // Keep as Date object
        updatedAt: { $first: "$updatedAt" }, // Keep as Date object
        orderIds: {
          $push: {
            order: "$orderDetails.orderId",
            quantity: "$orderDetails.numberOfPlants",
            orderDate: "$orderDetails.createdAt", // Keep as Date object
            rate: "$orderDetails.rate",
            payment: "$orderDetails.payment",
            orderStatus: "$orderDetails.orderStatus",
            paymentCompleted: "$orderDetails.paymentCompleted",
            returnedPlants: "$orderDetails.returnedPlants",
            returnReason: "$orderDetails.returnReason",
            plantDetails: {
              name: { $arrayElemAt: ["$plantDetails.name", 0] },
              variety: { $arrayElemAt: ["$plantDetails.variety", 0] },
              type: { $arrayElemAt: ["$plantDetails.type", 0] },
              subtype: { $arrayElemAt: ["$plantDetails.subtype", 0] },
            },
            farmerName: { $arrayElemAt: ["$farmerDetails.name", 0] },
            contact: { $arrayElemAt: ["$farmerDetails.mobileNumber", 0] },
            details: {
              farmer: {
                name: { $arrayElemAt: ["$farmerDetails.name", 0] },
                mobileNumber: {
                  $arrayElemAt: ["$farmerDetails.mobileNumber", 0],
                },
                village: { $arrayElemAt: ["$farmerDetails.village", 0] },
              },
              contact: { $arrayElemAt: ["$farmerDetails.mobileNumber", 0] },
              orderNotes: "$orderDetails.notes",
              payment: "$orderDetails.payment",
              orderid: "$orderDetails._id",
              salesPerson: {
                name: { $arrayElemAt: ["$salesPersonDetails.name", 0] },
                phoneNumber: {
                  $arrayElemAt: ["$salesPersonDetails.phoneNumber", 0],
                },
              },
              bookingSlot: {
                startDay: { $arrayElemAt: ["$bookingSlotDetails.startDay", 0] },
                endDay: { $arrayElemAt: ["$bookingSlotDetails.endDay", 0] },
                month: { $arrayElemAt: ["$bookingSlotDetails.month", 0] },
                subtypeId: {
                  $arrayElemAt: ["$bookingSlotDetails.subtypeId", 0],
                },
                _id: { $arrayElemAt: ["$bookingSlotDetails.slotId", 0] },
              },
            },
          },
        },
      },
    },
    // Final sort to maintain order after grouping
    {
      $sort: { createdAt: -1 },
    },
  ]);

  // Transform the results while maintaining Date objects
  const transformedDispatches = dispatches.map((dispatch) => ({
    ...dispatch,
    // Format dates for display only at this stage
    createdAt: dispatch.createdAt.toISOString(),
    updatedAt: dispatch.updatedAt.toISOString(),
    orderIds: dispatch.orderIds.map((order) => ({
      ...order,
      orderDate: order.orderDate.toISOString(),
      total: `₹ ${order.rate * order.quantity}`,
      "Paid Amt": `₹ ${order.payment?.reduce((sum, p) => sum + (p.paidAmount || 0), 0) || 0}`,
      "remaining Amt": `₹ ${order.rate * order.quantity - (order.payment?.reduce((sum, p) => sum + (p.paidAmount || 0), 0) || 0)}`,
      Delivery: order.details.bookingSlot
        ? `${order.details.bookingSlot.startDay} - ${order.details.bookingSlot.endDay} ${order.details.bookingSlot.month}, ${new Date().getFullYear()}`
        : "",
    })),
  }));

  // Debug logging
  // console.log(
  //   "Final sorted dates:",
  //   dispatches.map((d) => ({
  //     id: d._id,
  //     createdAt: d.createdAt,
  //     name: d.name,
  //   }))
  // );

  res
    .status(200)
    .json(
      generateResponse(
        "Success",
        "Dispatches fetched successfully",
        transformedDispatches
      )
    );
});
// Get single dispatch controller
const getDispatch = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const dispatch = await Dispatch.findById(id)
    .populate({
      path: "orderIds",
      populate: [
        {
          path: "farmer",
          select: "name mobileNumber village",
        },
        {
          path: "salesPerson",
          select: "name phoneNumber",
        },
        {
          path: "plantName",
          select: "name variety type subtype",
        },
        {
          path: "bookingSlot",
          select: "startDay endDay month",
        },
      ],
    })
    .lean(); // Using lean() for better performance

  if (!dispatch) {
    return next(new AppError("No dispatch found with that ID", 404));
  }

  // Transform the response to ensure all fields are included
  const transformedDispatch = {
    _id: dispatch._id,
    name: dispatch.name,
    transportId: dispatch.transportId,
    driverName: dispatch.driverName,
    vehicleName: dispatch.vehicleName,
    isDeleted: dispatch.isDeleted || false,
    returnedPlants: dispatch.returnedPlants || 0,
    transportStatus: dispatch.transportStatus || "PENDING",
    plantsDetails: dispatch.plantsDetails.map((plant) => ({
      name: plant.name,
      id: plant.id,
      plantId: plant.plantId,
      subTypeId: plant.subTypeId,
      quantity: plant.quantity,
      totalPlants: plant.totalPlants,
      pickupDetails: plant.pickupDetails.map((pickup) => ({
        shade: pickup.shade,
        shadeName: pickup.shadeName,
        quantity: pickup.quantity,
      })),
      crates: plant.crates.map((crate) => ({
        cavity: crate.cavity,
        cavityName: crate.cavityName,
        crateCount: crate.crateCount,
        plantCount: crate.plantCount,
        crateDetails: crate.crateDetails,
      })),
    })),
    orderIds: dispatch.orderIds.map((order) => ({
      _id: order._id,
      orderId: order.orderId,
      farmer: order.farmer,
      salesPerson: order.salesPerson,
      plantName: order.plantName,
      bookingSlot: order.bookingSlot,
      numberOfPlants: order.numberOfPlants,
      rate: order.rate,
      payment: order.payment,
      orderStatus: order.orderStatus,
      returnedPlants: order.returnedPlants,
      returnReason: order.returnReason,
    })),
    createdAt: dispatch.createdAt,
    updatedAt: dispatch.updatedAt,
  };

  const response = generateResponse(
    "Success",
    "Dispatch fetched successfully",
    transformedDispatch
  );

  res.status(200).json(response);
});

const removeTransport = async (req, res) => {
  try {
    const { transportId } = req.params;

    // Find and completely remove the dispatch document
    const dispatch = await Dispatch.findOneAndDelete({ transportId });

    if (!dispatch) {
      return res.status(404).json({
        success: false,
        message: "Transport not found",
      });
    }

    // Get order IDs before deletion
    const affectedOrderIds = [...dispatch.orderIds];

    // Update all associated orders' status to FARM_READY
    const updateOrdersResult = await Order.updateMany(
      { _id: { $in: affectedOrderIds } },
      { $set: { orderStatus: "FARM_READY" } }
    );

    return res.status(200).json({
      success: true,
      message: "Transport removed and orders updated successfully",
      data: {
        transportId: dispatch.transportId,
        affectedOrders: updateOrdersResult.modifiedCount,
      },
    });
  } catch (error) {
    // console.error("Error in removeTransport:", error);
    // return res.status(500).json({
    //   success: false,
    //   message: "Error removing transport",
    //   error: error.message,
    // });
  }
};
const handleDispatchReturns = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { orderUpdates } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const dispatch = await Dispatch.findById(id);

    if (!dispatch) {
      return next(new AppError("No dispatch found with that ID", 404));
    }

    // Calculate total returned plants
    const totalReturnedPlants =
      orderUpdates?.reduce(
        (sum, order) => sum + (Number(order.returnedPlants) || 0),
        0
      ) || 0;

    // Update dispatch with returned plants and transport status
    const updatedDispatch = await Dispatch.findByIdAndUpdate(
      id,
      {
        returnedPlants: totalReturnedPlants,
        transportStatus: "DELIVERED", // Update transport status to DELIVERED
      },
      { new: true, runValidators: true, session }
    );

    // Create map of order updates
    const orderUpdatesMap =
      orderUpdates?.reduce((map, update) => {
        map[update.orderId] = update;
        return map;
      }, {}) || {};

    // Update all orders and their booking slots
    const orderUpdatePromises = dispatch.orderIds.map(async (orderId) => {
      // First get the order
      const order = await Order.findById(orderId).session(session);

      if (!order) return null;

      // Calculate new numberOfPlants if there are returns
      const returnsForThisOrder = orderUpdatesMap[orderId]?.returnedPlants || 0;
      const newNumberOfPlants = order.numberOfPlants - returnsForThisOrder;

      // Update the order
      const updatedOrder = await Order.findByIdAndUpdate(
        orderId,
        {
          ...(orderUpdatesMap[orderId]
            ? {
                returnedPlants: orderUpdatesMap[orderId].returnedPlants,
                returnReason: orderUpdatesMap[orderId].returnReason,
                numberOfPlants: newNumberOfPlants,
              }
            : {}),
          orderStatus: "COMPLETED",
        },
        { new: true, runValidators: true, session }
      );

      // If order has returns, update the slot's totalPlants
      if (returnsForThisOrder > 0) {
        await mongoose.model("PlantSlot").updateOne(
          {
            "subtypeSlots.slots._id": order.bookingSlot,
          },
          {
            $inc: {
              "subtypeSlots.$[].slots.$[slot].totalPlants": returnsForThisOrder,
            },
          },
          {
            arrayFilters: [{ "slot._id": order.bookingSlot }],
            session,
          }
        );
      }

      return updatedOrder;
    });

    const updatedOrders = await Promise.all(orderUpdatePromises);

    // Check if any order update failed
    if (updatedOrders.includes(null)) {
      await session.abortTransaction();
      return next(new AppError("One or more orders not found", 404));
    }

    await session.commitTransaction();

    const response = generateResponse(
      "Success",
      "Dispatch completed, delivery status updated, and returns processed successfully",
      {
        dispatch: updatedDispatch,
        updatedOrders,
      }
    );

    res.status(200).json(response);
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});
/*
Example payload:
{
  "orderUpdates": [
    {
      "orderId": "6773f61461f4388d1bb59b7b",
      "returnedPlants": 100,
      "returnReason": "Quality issues with plants"
    }
    // ... other orders with returns
  ]
}
*/

/*
Example payload:
{
  "orderUpdates": [
    {
      "orderId": "65f1234567890abcdef12345",
      "returnedPlants": 6,
      "returnReason": "Plants damaged during transit"
    },
    {
      "orderId": "65f1234567890abcdef12346",
      "returnedPlants": 4,
      "returnReason": "Quality issues"
    }
  ]
}
*/

export { handleDispatchReturns };
/*
Example payload:
{
  "plantsDetails": [
    {
      "id": "ROSE-001",
      "quantity": 90
    }
  ],
  "orderUpdates": [
    {
      "orderId": "65f1234567890abcdef12345",
      "returnedPlants": 6,
      "returnReason": "Plants damaged during transit"
    },
    {
      "orderId": "65f1234567890abcdef12346",
      "returnedPlants": 4,
      "returnReason": "Quality issues"
    }
  ]
}
*/
// Route definition (to be added in routes file):
// router.delete('/transport/:transportId', removeTransport);

export {
  createDispatch,
  updateDispatch,
  getDispatches,
  getDispatch,
  removeTransport,
};
