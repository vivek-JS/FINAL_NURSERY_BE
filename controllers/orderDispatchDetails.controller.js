import catchAsync from "../utility/catchAsync.js";
import Order from "../models/order.model.js";
import Dispatch from "../models/dispatch.model.js";
import mongoose from "mongoose";

/**
 * Get dispatch details (driver, vehicle) for a specific order
 * GET /api/v1/order/dispatch-details/:orderId
 */
export const getOrderDispatchDetails = catchAsync(async (req, res) => {
  const { orderId } = req.params;

  // Validate orderId
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid order ID",
    });
  }

  // Find the order with dispatch history
  const order = await Order.findById(orderId)
    .populate({
      path: "dispatchHistory.dispatchId",
      select: "driverName vehicleName transportId transportStatus createdAt updatedAt",
    })
    .select("orderId orderStatus dispatchHistory numberOfPlants remainingPlants farmer salesPerson");

  if (!order) {
    return res.status(404).json({
      success: false,
      message: "Order not found",
    });
  }

  // Also find all dispatches that include this order
  const dispatches = await Dispatch.find({
    orderIds: orderId,
    isDeleted: false,
  })
    .select("driverName vehicleName transportId transportStatus orderDispatchDetails createdAt updatedAt")
    .sort({ createdAt: -1 });

  // Format the response
  const dispatchDetails = dispatches.map((dispatch) => {
    // Find the specific order details in this dispatch
    const orderDetail = dispatch.orderDispatchDetails?.find(
      (detail) => detail.orderId.toString() === orderId
    );

    return {
      dispatchId: dispatch._id,
      transportId: dispatch.transportId,
      driverName: dispatch.driverName,
      vehicleName: dispatch.vehicleName,
      transportStatus: dispatch.transportStatus,
      dispatchDate: dispatch.createdAt,
      lastUpdated: dispatch.updatedAt,
      dispatchQuantity: orderDetail?.dispatchQuantity || 0,
      remainingAfterDispatch: orderDetail?.remainingAfterDispatch || 0,
      isPartialDispatch: orderDetail?.isPartialDispatch || false,
    };
  });

  // Format dispatch history from order
  const dispatchHistoryDetails = order.dispatchHistory?.map((history) => ({
    date: history.date,
    quantity: history.quantity,
    remainingAfterDispatch: history.remainingAfterDispatch,
    processedBy: history.processedBy,
    dispatch: history.dispatchId
      ? {
          driverName: history.dispatchId.driverName,
          vehicleName: history.dispatchId.vehicleName,
          transportId: history.dispatchId.transportId,
          transportStatus: history.dispatchId.transportStatus,
        }
      : null,
  })) || [];

  return res.status(200).json({
    success: true,
    message: "Dispatch details retrieved successfully",
    data: {
      order: {
        _id: order._id,
        orderId: order.orderId,
        orderStatus: order.orderStatus,
        numberOfPlants: order.numberOfPlants,
        remainingPlants: order.remainingPlants,
      },
      dispatches: dispatchDetails,
      dispatchHistory: dispatchHistoryDetails,
      totalDispatches: dispatchDetails.length,
      hasDispatches: dispatchDetails.length > 0,
    },
  });
});

/**
 * Get all orders for a specific dispatch (by transportId)
 * GET /api/v1/order/by-dispatch/:transportId
 */
export const getOrdersByDispatch = catchAsync(async (req, res) => {
  const { transportId } = req.params;

  // Find the dispatch
  const dispatch = await Dispatch.findOne({ transportId, isDeleted: false })
    .populate({
      path: "orderIds",
      select: "orderId orderStatus numberOfPlants remainingPlants farmer salesPerson plantName plantSubtype",
      populate: [
        {
          path: "farmer",
          select: "name mobileNumber village taluka district state",
        },
        {
          path: "salesPerson",
          select: "name phoneNumber",
        },
      ],
    });

  if (!dispatch) {
    return res.status(404).json({
      success: false,
      message: "Dispatch not found",
    });
  }

  return res.status(200).json({
    success: true,
    message: "Orders retrieved successfully",
    data: {
      dispatch: {
        _id: dispatch._id,
        transportId: dispatch.transportId,
        driverName: dispatch.driverName,
        vehicleName: dispatch.vehicleName,
        transportStatus: dispatch.transportStatus,
        createdAt: dispatch.createdAt,
        updatedAt: dispatch.updatedAt,
      },
      orders: dispatch.orderIds,
      totalOrders: dispatch.orderIds?.length || 0,
    },
  });
});

/**
 * Get dispatch summary (all dispatches with driver and vehicle info)
 * GET /api/v1/order/dispatch-summary
 */
export const getDispatchSummary = catchAsync(async (req, res) => {
  const { status, startDate, endDate, limit = 50, page = 1 } = req.query;

  // Build filter
  const filter = { isDeleted: false };

  if (status) {
    filter.transportStatus = status;
  }

  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) {
      filter.createdAt.$gte = new Date(startDate);
    }
    if (endDate) {
      filter.createdAt.$lte = new Date(endDate);
    }
  }

  // Calculate pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);

  // Get dispatches with populated orders
  const dispatches = await Dispatch.find(filter)
    .populate({
      path: "orderIds",
      select: "orderId orderStatus numberOfPlants farmer",
      populate: {
        path: "farmer",
        select: "name village",
      },
    })
    .select("driverName vehicleName transportId transportStatus orderDispatchDetails createdAt")
    .sort({ createdAt: -1 })
    .limit(parseInt(limit))
    .skip(skip);

  const totalCount = await Dispatch.countDocuments(filter);

  // Format response
  const formattedDispatches = dispatches.map((dispatch) => {
    const totalPlants = dispatch.orderDispatchDetails?.reduce(
      (sum, detail) => sum + detail.dispatchQuantity,
      0
    ) || 0;

    return {
      dispatchId: dispatch._id,
      transportId: dispatch.transportId,
      driverName: dispatch.driverName,
      vehicleName: dispatch.vehicleName,
      transportStatus: dispatch.transportStatus,
      dispatchDate: dispatch.createdAt,
      totalOrders: dispatch.orderIds?.length || 0,
      totalPlants,
      orders: dispatch.orderIds?.map((order) => ({
        orderId: order.orderId,
        orderStatus: order.orderStatus,
        farmerName: order.farmer?.name,
        village: order.farmer?.village,
      })),
    };
  });

  return res.status(200).json({
    success: true,
    message: "Dispatch summary retrieved successfully",
    data: {
      dispatches: formattedDispatches,
      pagination: {
        total: totalCount,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(totalCount / parseInt(limit)),
      },
    },
  });
});

