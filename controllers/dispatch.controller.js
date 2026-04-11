import generateResponse from "../utility/responseFormat.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import Dispatch from "../models/dispatch.model.js";
import Order from "../models/order.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import ReadyDispatchGroup from "../models/readyDispatchGroup.model.js";
import PlantSlot from "../models/slots.model.js";
import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
import Tray from "../models/tray.model.js";
import Vehicle from "../models/vehicleModel.model.js";
import VehicleDriver from "../models/vehicleDriver.model.js";
import {
  syncFarmerPlantLedgerForOrderUpdate,
  roundMoney,
  resolveFundingDealerId,
} from "../utils/farmerPlantOrderLedgerHelper.js";
import { releaseDealerQuotaPartial } from "./quota.controller.js";
import DealerWallet from "../models/dealerWallet.js";
import { appendStatusChangeToUpdate } from "../utils/orderStatusAuditHelper.js";

const updateOrderWithLedgerSync = async ({
  orderId,
  updateOperation,
  session,
  userId,
  existingDoc,
  contextLabel = "dispatch_order_update",
  ledgerSyncOptions = {},
}) => {
  const previousOrder =
    existingDoc || (await Order.findById(orderId).session(session));
  if (!previousOrder) {
    throw new AppError(`Order not found: ${orderId}`, 404);
  }

  const opWithAudit = appendStatusChangeToUpdate(
    updateOperation,
    previousOrder.orderStatus,
    {
      userId,
      reason: contextLabel ? `dispatch:${contextLabel}` : "dispatch:order_update",
    }
  );

  const updatedOrder = await Order.findByIdAndUpdate(orderId, opWithAudit, {
    new: true,
    runValidators: true,
    session,
  });

  if (!updatedOrder) {
    throw new AppError(`Failed to update order: ${orderId}`, 500);
  }

  try {
    await syncFarmerPlantLedgerForOrderUpdate(
      previousOrder,
      updatedOrder,
      userId,
      session,
      { strict: true, ...ledgerSyncOptions }
    );
  } catch (ledgerErr) {
    console.error("Dispatch order ledger sync failed", {
      contextLabel,
      orderId: String(updatedOrder?._id || orderId),
      error: ledgerErr?.message || ledgerErr,
    });
    throw new AppError(
      `Order update reverted because ledger sync failed (${contextLabel}). Please retry.`,
      500
    );
  }

  console.log("Dispatch order ledger sync completed", {
    contextLabel,
    orderId: String(updatedOrder?._id || orderId),
    oldRate: Number(previousOrder?.rate || 0),
    newRate: Number(updatedOrder?.rate || 0),
    oldQuantity:
      Number(previousOrder?.numberOfPlants || 0) +
      Number(previousOrder?.additionalPlants || 0),
    newQuantity:
      Number(updatedOrder?.numberOfPlants || 0) +
      Number(updatedOrder?.additionalPlants || 0),
    oldStatus: previousOrder?.orderStatus,
    newStatus: updatedOrder?.orderStatus,
  });

  return updatedOrder;
};
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

// Generate unique transport ID with max attempts to prevent infinite recursion
const generateTransportId = async (attempts = 0) => {
  const maxAttempts = 10;
  
  if (attempts >= maxAttempts) {
    throw new AppError('Unable to generate unique transport ID after multiple attempts', 500);
  }
  
  // Get the maximum transportId and increment
  // Get all dispatches and find the max numeric transportId
  const dispatches = await Dispatch.find({ transportId: { $exists: true, $ne: null } })
    .select('transportId')
    .lean();
  
  let maxId = 0;
  if (dispatches.length > 0) {
    const numericIds = dispatches
      .map(d => parseInt(d.transportId, 10))
      .filter(id => !isNaN(id));
    
    if (numericIds.length > 0) {
      maxId = Math.max(...numericIds);
    }
  }
  
  const newTransportId = (maxId + 1).toString();
  
  // Double-check that this ID doesn't exist (race condition handling)
  const exists = await Dispatch.findOne({ transportId: newTransportId });
  
  if (exists) {
    // If it exists, recursively try next number
    return generateTransportId(attempts + 1);
  }
  
  return newTransportId;
};

const ensureLinkedAgriLoadComplete = async (orderIds = []) => {
  const normalizedOrderIds = (Array.isArray(orderIds) ? orderIds : [])
    .filter((id) => mongoose.isValidObjectId(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!normalizedOrderIds.length) {
    return;
  }

  const blockingAgriOrders = await AgriSalesOrder.find({
    linkedNurseryOrderId: { $in: normalizedOrderIds },
    orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
    agriLoadStatus: { $ne: "LOADED" },
  })
    .select("orderNumber linkedNurseryOrderCode customerName productName quantity agriLoadStatus")
    .lean();

  if (blockingAgriOrders.length > 0) {
    const orderRefs = blockingAgriOrders
      .map((o) => o.linkedNurseryOrderCode || String(o.linkedNurseryOrderId || ""))
      .filter(Boolean)
      .join(", ");
    throw new AppError(
      `AGRI_LOAD_PENDING: Linked Agri Inputs not loaded for nursery order(s): ${orderRefs}`,
      409
    );
  }
};

const createDispatch = catchAsync(async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const dispatchRequest = { ...req.body };
    const readyDispatchGroupId = dispatchRequest.readyDispatchGroupId;
    if (readyDispatchGroupId !== undefined) {
      delete dispatchRequest.readyDispatchGroupId;
    }

    // ── Auto-populate driverName / vehicleName from CMS when IDs are provided ──
    if (dispatchRequest.vehicleId && mongoose.isValidObjectId(String(dispatchRequest.vehicleId))) {
      const vehicle = await Vehicle.findById(dispatchRequest.vehicleId).lean();
      if (vehicle) {
        dispatchRequest.vehicleName = dispatchRequest.vehicleName || vehicle.name || "";
        dispatchRequest.vehicleNumber = dispatchRequest.vehicleNumber || vehicle.number || "";
        if (!dispatchRequest.driverName) {
          dispatchRequest.driverName = vehicle.driverName || "";
          dispatchRequest.driverMobile = dispatchRequest.driverMobile || vehicle.driverMobile || "";
        }
      }
    }
    if (dispatchRequest.driverId && mongoose.isValidObjectId(String(dispatchRequest.driverId))) {
      const driver = await VehicleDriver.findById(dispatchRequest.driverId).lean();
      if (driver) {
        dispatchRequest.driverName = dispatchRequest.driverName || driver.name || "";
        dispatchRequest.driverMobile = dispatchRequest.driverMobile || driver.mobile || "";
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    // Modify each plant's details and convert cavity strings to ObjectIds
    dispatchRequest.plantsDetails = dispatchRequest.plantsDetails.map(
      (plant) => ({
        ...plant,
        totalPlants: plant.pickupDetails.reduce(
          (sum, detail) => sum + detail.quantity,
          0
        ),
        pickupDetails: plant.pickupDetails.map((pickup) => ({
          ...pickup,
          cavity: typeof pickup.cavity === 'string' 
            ? new mongoose.Types.ObjectId(pickup.cavity) 
            : pickup.cavity,
        })),
        crates: plant.crates.map((crate) => ({
          cavity: typeof crate.cavity === 'string'
            ? new mongoose.Types.ObjectId(crate.cavity)
            : crate.cavity,
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
    await ensureLinkedAgriLoadComplete(dispatchRequest.orderIds);
    dispatchRequest.transportId = await generateTransportId();

    const dispatch = await Dispatch.create([dispatchRequest], { session });

    // Handle partial/split dispatches if orderDispatchDetails is provided
    if (dispatchRequest.orderDispatchDetails && dispatchRequest.orderDispatchDetails.length > 0) {
      // Update each order individually with dispatch details
      for (const orderDispatch of dispatchRequest.orderDispatchDetails) {
        const order = await Order.findById(orderDispatch.orderId).session(session);
        
        if (!order) {
          throw new AppError(`Order not found: ${orderDispatch.orderId}`, 404);
        }

        // Validate dispatch quantity
        const currentRemaining = order.remainingPlants || order.numberOfPlants;
        if (orderDispatch.dispatchQuantity > currentRemaining) {
          throw new AppError(
            `Dispatch quantity (${orderDispatch.dispatchQuantity}) exceeds remaining plants (${currentRemaining}) for order ${order.orderId}`,
            400
          );
        }

        // Update remainingPlants
        const newRemainingPlants = currentRemaining - orderDispatch.dispatchQuantity;
        
        // Determine new status based on remaining plants
        let newStatus = order.orderStatus;
        if (newRemainingPlants === 0) {
          // Fully dispatched
          newStatus = "DISPATCHED";
        } else if (newRemainingPlants < currentRemaining) {
          // Partially dispatched
          newStatus = "DISPATCH_PROCESS";
        }

        // Add dispatch history entry
        const dispatchHistoryEntry = {
          date: new Date(),
          quantity: orderDispatch.dispatchQuantity,
          dispatchId: dispatch[0]._id,
          remainingAfterDispatch: newRemainingPlants,
          processedBy: req.user ? req.user._id : null,
          driverName: dispatchRequest.driverName || "",
          vehicleName: dispatchRequest.vehicleName || "",
        };

        // Update the order
        await updateOrderWithLedgerSync({
          orderId: orderDispatch.orderId,
          existingDoc: order,
          updateOperation: {
            $set: {
              remainingPlants: newRemainingPlants,
              orderStatus: newStatus,
              currentDispatchId: dispatch[0]._id, // Set the current dispatch reference
            },
            $push: {
              dispatchHistory: dispatchHistoryEntry,
            },
          },
          session,
          userId: req.user?._id,
          contextLabel: "create_dispatch_split_update",
        });
      }
    } else {
      // Legacy behavior: update all orders to DISPATCH_PROCESS (filter fixes previous status)
      await Order.updateMany(
        { _id: { $in: dispatchRequest.orderIds }, orderStatus: "FARM_READY" },
        {
          $set: {
            orderStatus: "DISPATCH_PROCESS",
            currentDispatchId: dispatch[0]._id,
          },
          $push: {
            statusChanges: {
              previousStatus: "FARM_READY",
              newStatus: "DISPATCH_PROCESS",
              ...(req.user?._id && { changedBy: req.user._id }),
              reason: "dispatch:create_dispatch_legacy_farm_ready_bulk",
            },
          },
        },
        { session }
      );
    }

    if (
      readyDispatchGroupId &&
      mongoose.isValidObjectId(String(readyDispatchGroupId))
    ) {
      await ReadyDispatchGroup.findByIdAndUpdate(
        readyDispatchGroupId,
        {
          $set: {
            convertedDispatchId: dispatch[0]._id,
            status: "DISPATCHED",
          },
        },
        { session }
      );
    }

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

  // Use runValidators only when doing a full replacement (not $push/$pull operators),
  // because Mongoose calls array validators on individual pushed elements rather than
  // the full resulting array, which would wrongly fail the "length >= 1" check on orderIds.
  const isOperatorUpdate = Object.keys(req.body).some((k) => k.startsWith("$"));
  const dispatch = await Dispatch.findByIdAndUpdate(id, req.body, {
    new: true,
    runValidators: !isOperatorUpdate,
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

// Dedicated endpoint to add a post-dispatch (quick) order to an existing dispatch vehicle.
// Uses $push internally so it is safe behind express-mongo-sanitize.
const addOrderToDispatch = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { orderId, dispatchQuantity } = req.body;

  if (!orderId) {
    return next(new AppError("orderId is required", 400));
  }

  const qty = Number(dispatchQuantity) || 0;

  // Fetch the dispatch first so we can copy vehicle/driver info to the order's dispatchHistory
  const existingDispatch = await Dispatch.findById(id).lean();
  if (!existingDispatch) {
    return next(new AppError("No dispatch found with that ID", 404));
  }

  // 1. Add order to the dispatch record
  const dispatch = await Dispatch.findByIdAndUpdate(
    id,
    {
      $push: {
        orderIds: orderId,
        afterDispatchedOrderIds: orderId,
        orderDispatchDetails: {
          orderId,
          dispatchQuantity: qty,
          remainingAfterDispatch: 0,
          additionalPlants: qty,
          totalPlantsAfterAdjustments: qty,
        },
      },
    },
    { new: true, runValidators: false }
  );

  // 2. Write the dispatch trail back onto the Order so it shows up in order views
  await Order.findByIdAndUpdate(
    orderId,
    {
      $push: {
        dispatchHistory: {
          date: new Date(),
          quantity: qty,
          dispatchId: id,
          remainingAfterDispatch: 0,
          driverName: existingDispatch.driverName || "",
          vehicleName: existingDispatch.vehicleName || "",
        },
      },
    },
    { runValidators: false }
  );

  const response = generateResponse(
    "Success",
    "Order added to dispatch successfully",
    dispatch
  );

  res.status(200).json(response);
});

// Get dispatches controller
const getDispatches = catchAsync(async (req, res, next) => {
  try {
    // Perform the initial aggregation pipeline
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
          orderDispatchDetails: { $first: "$orderDispatchDetails" },
          returnedPlants: { $first: "$returnedPlants" },
          transportStatus: { $first: "$transportStatus" },
          createdAt: { $first: "$createdAt" }, // Keep as Date object
          updatedAt: { $first: "$updatedAt" }, // Keep as Date object
          orderIds: {
            $push: {
              _id: "$orderDetails._id",
              order: "$orderDetails.orderId",
              quantity: "$orderDetails.numberOfPlants",
              remainingPlants: "$orderDetails.remainingPlants",
              deliveryDate: "$orderDetails.deliveryDate", // Delivery date from order
              rate: "$orderDetails.rate",
              payment: "$orderDetails.payment",
              orderStatus: "$orderDetails.orderStatus",
              paymentCompleted: "$orderDetails.paymentCompleted",
              returnedPlants: "$orderDetails.returnedPlants",
              returnReason: "$orderDetails.returnReason",
              quotaSource: "$orderDetails.quotaSource",
              additionalPlants: "$orderDetails.additionalPlants",
              numberOfPlants: "$orderDetails.numberOfPlants",
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
                quotaSource: "$orderDetails.quotaSource",
                orderid: "$orderDetails._id",
                salesPerson: {
                  name: { $arrayElemAt: ["$salesPersonDetails.name", 0] },
                  phoneNumber: {
                    $arrayElemAt: ["$salesPersonDetails.phoneNumber", 0],
                  },
                },
                bookingSlot: {
                  startDay: {
                    $arrayElemAt: ["$bookingSlotDetails.startDay", 0],
                  },
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

    // Get all cavity IDs from all dispatches
    const allCavityIds = [];
    for (const dispatch of dispatches) {
      for (const plant of dispatch.plantsDetails || []) {
        // Get cavity IDs from pickup details
        if (Array.isArray(plant.pickupDetails)) {
          plant.pickupDetails.forEach((pickup) => {
            if (pickup.cavity) {
              allCavityIds.push(pickup.cavity);
            }
          });
        }

        // Get cavity IDs from crates
        if (Array.isArray(plant.crates)) {
          plant.crates.forEach((crate) => {
            if (crate.cavity) {
              allCavityIds.push(crate.cavity);
            }
          });
        }
      }
    }

    // Get unique cavity IDs
    const uniqueCavityIds = [
      ...new Set(allCavityIds.map((id) => id.toString())),
    ];

    // Fetch all trays in one go
    const trays = await Tray.find({
      _id: {
        $in: uniqueCavityIds.map((id) => new mongoose.Types.ObjectId(id)),
      },
    }).lean();

    // Create a lookup map
    const trayMap = trays.reduce((map, tray) => {
      map[tray._id.toString()] = tray;
      return map;
    }, {});

    // Transform dispatches with tray information
    const transformedDispatches = dispatches.map((dispatch) => {
      // Process plant details with cavity information
      const plantDetailsWithCavity = dispatch.plantsDetails.map((plant) => {
        // Calculate cavity count
        const uniqueCavities = new Set();
        if (Array.isArray(plant.pickupDetails)) {
          plant.pickupDetails.forEach((pickup) => {
            if (pickup.cavity) {
              uniqueCavities.add(pickup.cavity.toString());
            }
          });
        }

        // Process pickup details
        const pickupDetailsWithCavity = Array.isArray(plant.pickupDetails)
          ? plant.pickupDetails.map((pickup) => {
              const cavityId = pickup.cavity ? pickup.cavity.toString() : null;
              const tray = cavityId ? trayMap[cavityId] : null;

              return {
                ...pickup,
                cavity: cavityId,
                cavityName: tray ? tray.name : pickup.cavityName || "",
                numberPerCrate: tray ? tray.numberPerCrate : null,
                cavitySize: tray ? tray.cavity : null,
              };
            })
          : [];

        // Process crates
        const cratesWithCavity = Array.isArray(plant.crates)
          ? plant.crates.map((crate) => {
              const cavityId = crate.cavity ? crate.cavity.toString() : null;
              const tray = cavityId ? trayMap[cavityId] : null;

              return {
                ...crate,
                cavity: cavityId,
                cavityName: tray ? tray.name : crate.cavityName || "",
                numberPerCrate: tray ? tray.numberPerCrate : null,
                cavitySize: tray ? tray.cavity : null,
              };
            })
          : [];

        return {
          ...plant,
          cavityCount: uniqueCavities.size,
          pickupDetails: pickupDetailsWithCavity,
          crates: cratesWithCavity,
        };
      });

      return {
        ...dispatch,
        plantsDetails: plantDetailsWithCavity,
        orderDispatchDetails: dispatch.orderDispatchDetails || [], // Include dispatch details
        // Format dates for display
        createdAt: dispatch.createdAt.toISOString(),
        updatedAt: dispatch.updatedAt.toISOString(),
        orderIds: dispatch.orderIds.map((order) => ({
          ...order,
          deliveryDate: order.deliveryDate?.toISOString(),
          total: `₹ ${order.rate * order.quantity}`,
          "Paid Amt": `₹ ${
            order.payment?.reduce((sum, p) => sum + (p.paidAmount || 0), 0) || 0
          }`,
          "remaining Amt": `₹ ${
            order.rate * order.quantity -
            (order.payment?.reduce((sum, p) => sum + (p.paidAmount || 0), 0) ||
              0)
          }`,
          Delivery: order.details.bookingSlot
            ? `${order.details.bookingSlot.startDay} - ${
                order.details.bookingSlot.endDay
              } ${order.details.bookingSlot.month}, ${new Date().getFullYear()}`
            : "",
        })),
      };
    });

    res
      .status(200)
      .json(
        generateResponse(
          "Success",
          "Dispatches fetched successfully",
          transformedDispatches
        )
      );
  } catch (error) {
    console.error("Error in getDispatches:", error);
    next(error);
  }
});
// Get single dispatch controller
const getDispatch = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  console.log("hiii");
  try {
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

    // Separately get all relevant tray data to ensure we have the info
    const trayIds = [];

    // Collect all cavity IDs from pickupDetails
    dispatch.plantsDetails.forEach((plant) => {
      if (Array.isArray(plant.pickupDetails)) {
        plant.pickupDetails.forEach((pickup) => {
          if (pickup.cavity) {
            trayIds.push(pickup.cavity);
          }
        });
      }

      // Collect all cavity IDs from crates
      if (Array.isArray(plant.crates)) {
        plant.crates.forEach((crate) => {
          if (crate.cavity) {
            trayIds.push(crate.cavity);
          }
        });
      }
    });

    // Get unique tray IDs
    const uniqueTrayIds = [...new Set(trayIds.map((id) => id.toString()))];

    // Fetch all relevant trays in one query
    const trays = await Tray.find({ _id: { $in: uniqueTrayIds } }).lean();

    // Create a lookup map for easy access
    const trayMap = trays.reduce((map, tray) => {
      map[tray._id.toString()] = tray;
      return map;
    }, {});

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
      orderDispatchDetails: dispatch.orderDispatchDetails || [], // Include dispatch details
      plantsDetails: dispatch.plantsDetails.map((plant) => {
        // Calculate cavity count
        const uniqueCavities = new Set();
        if (Array.isArray(plant.pickupDetails)) {
          plant.pickupDetails.forEach((pickup) => {
            if (pickup.cavity) {
              uniqueCavities.add(pickup.cavity.toString());
            }
          });
        }

        return {
          name: plant.name,
          id: plant.id,
          plantId: plant.plantId,
          subTypeId: plant.subTypeId,
          quantity: plant.quantity,
          totalPlants: plant.totalPlants,
          cavityCount: uniqueCavities.size,
          pickupDetails: Array.isArray(plant.pickupDetails)
            ? plant.pickupDetails.map((pickup) => {
                const cavityId = pickup.cavity
                  ? pickup.cavity.toString()
                  : null;
                const tray = cavityId ? trayMap[cavityId] : null;
                console.log("tray", tray);
                return {
                  shade: pickup.shade,
                  shadeName: pickup.shadeName,
                  quantity: pickup.quantity,
                  cavity: cavityId,
                  cavityName: tray ? tray.name : pickup.cavityName || "",
                  numberPerCrate: tray ? tray.numberPerCrate : null,
                  cavitySize: tray ? tray.cavity : null,
                };
              })
            : [],
          crates: Array.isArray(plant.crates)
            ? plant.crates.map((crate) => {
                const cavityId = crate.cavity ? crate.cavity.toString() : null;
                const tray = cavityId ? trayMap[cavityId] : null;
                console.log("tray", tray);

                return {
                  cavity: cavityId,
                  cavityName: tray ? tray.name : crate.cavityName || "",
                  cavitySize: tray ? tray.cavity : null,
                  numberPerCrate: tray ? tray.numberPerCrate : null,
                  crateCount: crate.crateCount,
                  plantCount: crate.plantCount,
                  crateDetails: crate.crateDetails || [],
                };
              })
            : [],
        };
      }),
      orderIds: dispatch.orderIds.map((order) => ({
        _id: order._id,
        orderId: order.orderId,
        farmer: order.farmer,
        salesPerson: order.salesPerson,
        plantName: order.plantName,
        bookingSlot: order.bookingSlot,
        numberOfPlants: order.numberOfPlants,
        remainingPlants: order.remainingPlants || order.numberOfPlants, // Include remainingPlants
        rate: order.rate,
        payment: order.payment,
        orderStatus: order.orderStatus,
        returnedPlants: order.returnedPlants,
        returnReason: order.returnReason,
        quotaSource: order.quotaSource,
        additionalPlants: order.additionalPlants,
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
  } catch (error) {
    console.error("Error in getDispatch:", error);
    next(error);
  }
});

const removeTransport = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { transportId } = req.params;

    // Find the dispatch document
    const dispatch = await Dispatch.findOne({ transportId }).session(session);

    if (!dispatch) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: "Transport not found",
      });
    }

    const ordersUpdated = [];

    // Update orders to restore quantities
    if (dispatch.orderDispatchDetails && dispatch.orderDispatchDetails.length > 0) {
      for (const orderDispatch of dispatch.orderDispatchDetails) {
        const order = await Order.findById(orderDispatch.orderId).session(session);
        
        if (!order) {
          console.log(`Order not found: ${orderDispatch.orderId}`);
          continue;
        }

        console.log(`Processing order ${order.orderId}, current remainingPlants: ${order.remainingPlants}`);
        console.log(`Dispatch history count: ${order.dispatchHistory?.length || 0}`);

        // Get the dispatch history entry for this dispatch
        const dispatchHistoryEntry = order.dispatchHistory?.find(
          entry => {
            if (!entry.dispatchId) return false;
            return entry.dispatchId.toString() === dispatch._id.toString();
          }
        );

        if (dispatchHistoryEntry) {
          console.log(`Found dispatch history entry with quantity: ${dispatchHistoryEntry.quantity}`);
          
          // Restore the quantity
          const restoredRemainingPlants = order.remainingPlants + dispatchHistoryEntry.quantity;
          
          console.log(`Restoring quantity: ${order.remainingPlants} + ${dispatchHistoryEntry.quantity} = ${restoredRemainingPlants}`);
          
          // Determine new status
          let newStatus = "READY_FOR_DISPATCH";
          
          // If order was partially dispatched (has other dispatch history entries)
          const hasOtherDispatches = order.dispatchHistory?.filter(
            entry => entry._id && entry._id.toString() !== dispatchHistoryEntry._id.toString()
          ).length > 0;
          
          if (hasOtherDispatches && order.numberOfPlants !== restoredRemainingPlants) {
            newStatus = "DISPATCH_PROCESS";
            console.log(`Order has other dispatches, setting status to DISPATCH_PROCESS`);
          } else {
            console.log(`Setting order status to ${newStatus}`);
          }

          // Update order: restore quantity and update status (+ audit trail for reports)
          await Order.findByIdAndUpdate(
            orderDispatch.orderId,
            appendStatusChangeToUpdate(
              {
                $set: {
                  remainingPlants: restoredRemainingPlants,
                  orderStatus: newStatus,
                },
              },
              order.orderStatus,
              {
                userId: req.user?._id,
                reason: "dispatch:remove_transport_restore",
              }
            ),
            { session }
          );

          // Remove dispatch history entry separately
          await Order.findByIdAndUpdate(
            orderDispatch.orderId,
            {
              $pull: {
                dispatchHistory: {
                  _id: dispatchHistoryEntry._id,
                },
              },
            },
            { session }
          );

          ordersUpdated.push({
            orderId: order.orderId,
            restoredQuantity: dispatchHistoryEntry.quantity,
            newRemainingPlants: restoredRemainingPlants,
          });
        } else {
          console.log(`No dispatch history entry found for this dispatch`);
          await Order.findByIdAndUpdate(
            orderDispatch.orderId,
            appendStatusChangeToUpdate(
              { $set: { orderStatus: "READY_FOR_DISPATCH" } },
              order.orderStatus,
              {
                userId: req.user?._id,
                reason: "dispatch:remove_transport_no_history",
              }
            ),
            { session }
          );
        }
      }
    } else {
      console.log(`No orderDispatchDetails found, using legacy per-order update`);
      const ids = dispatch.orderIds || [];
      for (const oid of ids) {
        const o = await Order.findById(oid).session(session);
        if (!o) continue;
        await Order.findByIdAndUpdate(
          oid,
          appendStatusChangeToUpdate(
            { $set: { orderStatus: "READY_FOR_DISPATCH" } },
            o.orderStatus,
            {
              userId: req.user?._id,
              reason: "dispatch:remove_transport_legacy_bulk",
            }
          ),
          { session }
        );
      }
    }

    // Delete the dispatch document
    await Dispatch.deleteOne({ _id: dispatch._id }, { session });

    await session.commitTransaction();

    return res.status(200).json({
      success: true,
      message: "Transport removed and orders updated successfully",
      data: {
        transportId: dispatch.transportId,
        ordersUpdated,
      },
    });
  } catch (error) {
    await session.abortTransaction();
    console.error("Error in removeTransport:", error);
    return res.status(500).json({
      success: false,
      message: "Error removing transport",
      error: error.message,
    });
  } finally {
    session.endSession();
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

    // Create map of order updates (normalize keys — orderId may be string or ObjectId)
    const orderUpdatesMap =
      orderUpdates?.reduce((map, update) => {
        if (update?.orderId != null) {
          map[String(update.orderId)] = update;
        }
        return map;
      }, {}) || {};

    // Update all orders and their booking slots
    const orderUpdatePromises = dispatch.orderIds.map(async (orderId) => {
      // First get the order (populate for ledger descriptions / quota release)
      const order = await Order.findById(orderId)
        .populate("farmer", "name")
        .populate("plantName", "name")
        .session(session);

      if (!order) return null;

      // Get the update data for this order
      const orderUpdate = orderUpdatesMap[String(orderId)];
      if (!orderUpdate) {
        // If no update data found for this order, return the original order
        return order;
      }

      // Get the returns for this order
      const returnsForThisOrder = Math.max(
        0,
        Number.isNaN(Number(orderUpdate.returnedPlants))
          ? 0
          : Number(orderUpdate.returnedPlants)
      );

      const hasAdditionalUpdate =
        orderUpdate.additionalPlants !== undefined &&
        orderUpdate.additionalPlants !== null;
      const additionalPlantsValue = hasAdditionalUpdate
        ? Math.max(
            0,
            Number.isNaN(Number(orderUpdate.additionalPlants))
              ? 0
              : Number(orderUpdate.additionalPlants)
          )
        : order.additionalPlants || 0;

      // Order total always from DB base + (payload additional when editing additional only)
      const totalOrderedPlants =
        (order.numberOfPlants || 0) + additionalPlantsValue;

      // Calculate the total returnedPlants (existing + new returns)
      const existingReturnedPlants = order.returnedPlants || 0;
      const totalReturnedPlants = existingReturnedPlants + returnsForThisOrder;

      if (totalReturnedPlants > totalOrderedPlants) {
        const orderDisplayId = order.orderId || order._id?.toString();
        throw new AppError(
          `Returned plants cannot exceed the total plants for Order #${orderDisplayId}`,
          400
        );
      }

      // Prepare update object for the order - initially empty
      const orderUpdateData = {};

      if (hasAdditionalUpdate) {
        orderUpdateData.additionalPlants = additionalPlantsValue;
        orderUpdateData.totalPlants = totalOrderedPlants;

        if (orderUpdate.additionalPlantsChangeReason) {
          orderUpdateData.additionalPlantsChangeReason =
            orderUpdate.additionalPlantsChangeReason;
        }
        if (orderUpdate.additionalPlantsChangeNotes) {
          orderUpdateData.additionalPlantsChangeNotes =
            orderUpdate.additionalPlantsChangeNotes;
        }
        if (orderUpdate.additionalPlantsChangedBy) {
          orderUpdateData.additionalPlantsChangedBy =
            orderUpdate.additionalPlantsChangedBy;
        }

        await Dispatch.updateOne(
          { _id: dispatch._id, "orderDispatchDetails.orderId": order._id },
          {
            $set: {
              "orderDispatchDetails.$.additionalPlants": additionalPlantsValue,
              "orderDispatchDetails.$.totalPlantsAfterAdjustments":
                totalOrderedPlants,
            },
          },
          { session }
        );
      }

      // Check if action properties exist with updated format from frontend
      const completeOrder = orderUpdate.actions?.completeOrder === true;
      const addToInventory = orderUpdate.actions?.addToInventory === true;
      const finalStatusFromActions = orderUpdate.actions?.finalStatus;

      // Prefer explicit finalStatus from UI (e.g. READY_FOR_DISPATCH when remainingPlants > 0)
      if (finalStatusFromActions) {
        orderUpdateData.orderStatus = finalStatusFromActions;
      } else if (completeOrder) {
        orderUpdateData.orderStatus = "COMPLETED";
      } else if (returnsForThisOrder > 0) {
        orderUpdateData.orderStatus = "PARTIALLY_COMPLETED";
      }

      let returnHistoryEntry = null;
      // Only update return-related fields if there are actual returns
      if (returnsForThisOrder > 0) {
        orderUpdateData.returnedPlants = totalReturnedPlants;

        if (orderUpdate.returnReason) {
          orderUpdateData.returnReason = orderUpdate.returnReason;
        }

        // Add to return history regardless of whether adding to inventory.
        returnHistoryEntry = {
          date: new Date(),
          quantity: returnsForThisOrder,
          reason: orderUpdate.returnReason || "Return from dispatch",
          dispatchId: dispatch._id,
          processedBy: req.user ? req.user._id : undefined,
        };
      }

      // remainingPlants = undispatched at nursery; returns do not increase it.
      if (hasAdditionalUpdate) {
        const prevRem = Number(order.remainingPlants) || 0;
        const prevAdd = order.additionalPlants || 0;
        const deltaAdd = additionalPlantsValue - prevAdd;
        orderUpdateData.remainingPlants = Math.max(0, prevRem + deltaAdd);
      }

      const collectedAmount = roundMoney(
        (order.payment || []).reduce((sum, payment) => {
          if (payment?.paymentStatus === "COLLECTED") {
            return sum + (payment.paidAmount || 0);
          }
          return sum;
        }, 0)
      );

      const recalculatedTotalAmount = roundMoney(
        (order.rate || 0) * totalOrderedPlants
      );
      const isPaymentComplete = collectedAmount >= recalculatedTotalAmount;

      orderUpdateData.orderPaymentStatus = isPaymentComplete
        ? "COMPLETED"
        : "PENDING";
      orderUpdateData.paymentCompleted = isPaymentComplete;

      // Split returns between dealer plant quota vs nursery slot (hybrid orders)
      const fromWallet =
        Number(order.originalQuotaAllocation?.fromWallet) ||
        Number(order.quotaUsed) ||
        0;
      const fromSlot =
        Number(order.originalQuotaAllocation?.fromSlot) || 0;
      const prevDealerReturned = Number(order.dealerQuotaReturnedPlants) || 0;
      const prevSlotReturned = Number(order.nurserySlotReturnedPlants) || 0;

      const isDealerQuotaOrder =
        order.quotaSource === "dealer" && fromWallet > 0;

      let dealerReleaseQty = 0;
      let slotReleaseQty = 0;

      // Dealer cash wallet: credit-back proportional to COLLECTED wallet-funded payments
      let walletReturnCreditAmount = 0;
      const totalWalletCollected = roundMoney(
        (order.payment || []).reduce((sum, p) => {
          if (p.paymentStatus === "COLLECTED" && p.isWalletPayment) {
            return sum + (Number(p.paidAmount) || 0);
          }
          return sum;
        }, 0)
      );
      if (
        totalReturnedPlants > 0 &&
        totalOrderedPlants > 0 &&
        totalWalletCollected > 0
      ) {
        const cumulativeTarget = roundMoney(
          totalWalletCollected * (totalReturnedPlants / totalOrderedPlants)
        );
        const prevApplied = Number(order.walletReturnCreditApplied) || 0;
        walletReturnCreditAmount = Math.max(
          0,
          Math.min(
            cumulativeTarget - prevApplied,
            roundMoney(totalWalletCollected - prevApplied)
          )
        );
      }

      if (returnsForThisOrder > 0 && addToInventory) {
        if (isDealerQuotaOrder) {
          const dealerCap = Math.max(0, fromWallet - prevDealerReturned);
          dealerReleaseQty = Math.min(returnsForThisOrder, dealerCap);
          const slotCap = Math.max(0, fromSlot - prevSlotReturned);
          slotReleaseQty = Math.min(
            Math.max(0, returnsForThisOrder - dealerReleaseQty),
            slotCap
          );
        } else {
          slotReleaseQty = returnsForThisOrder;
        }
      }

      // Skip update if there's nothing to update (which should never happen now
      // since we always set an orderStatus)
      if (Object.keys(orderUpdateData).length === 0) {
        return order;
      }

      // Update the order
      const updateOperation = {
        $set: orderUpdateData,
      };
      if (returnHistoryEntry) {
        updateOperation.$push = { returnHistory: returnHistoryEntry };
      }
      if (
        dealerReleaseQty > 0 ||
        slotReleaseQty > 0 ||
        walletReturnCreditAmount > 0
      ) {
        updateOperation.$inc = {};
        if (dealerReleaseQty > 0) {
          updateOperation.$inc.dealerQuotaReturnedPlants = dealerReleaseQty;
        }
        if (slotReleaseQty > 0) {
          updateOperation.$inc.nurserySlotReturnedPlants = slotReleaseQty;
        }
        if (walletReturnCreditAmount > 0) {
          updateOperation.$inc.walletReturnCreditApplied = walletReturnCreditAmount;
        }
      }

      const updatedOrder = await updateOrderWithLedgerSync({
        orderId,
        existingDoc: order,
        updateOperation,
        session,
        userId: req.user?._id,
        contextLabel: "complete_dispatch_order_update",
        ledgerSyncOptions: { orderEditSource: "dispatch_complete" },
      });

      if (walletReturnCreditAmount > 0) {
        const dealerId = await resolveFundingDealerId(updatedOrder);
        if (dealerId) {
          await DealerWallet.addPayment(
            dealerId,
            walletReturnCreditAmount,
            `Dispatch return credit-back (wallet-funded payment) — Order ${
              updatedOrder.orderId ?? order._id
            }`,
            req.user?._id,
            "ADJUSTMENT",
            updatedOrder._id,
            session,
            { source: "dispatch_return" }
          );
        }
      }

      if (dealerReleaseQty > 0) {
        const orderForRelease =
          typeof updatedOrder?.toObject === "function"
            ? updatedOrder.toObject()
            : { ...updatedOrder };
        orderForRelease.farmer = order.farmer;
        orderForRelease.plantName = order.plantName;
        await releaseDealerQuotaPartial(
          orderForRelease,
          dealerReleaseQty,
          session,
          req.user?._id
        );
      }

      // Return to nursery slot: company / regular orders, or hybrid slot portion only (not dealer-only quota)
      if (slotReleaseQty > 0 && order.bookingSlot) {
        const slotDoc = await PlantSlot.findOne(
          { "subtypeSlots.slots._id": order.bookingSlot },
          { "subtypeSlots.$": 1 }
        )
          .populate("plantId", "sowingAllowed")
          .session(session);

        const isSowingAllowed = slotDoc?.plantId?.sowingAllowed || false;
        const isReadyPlantsOrder = !!(
          order.productMappingId && order.productName
        );

        const slotInc = {
          "subtypeSlots.$[subtypeSlot].slots.$[slot].totalBookedPlants":
            -slotReleaseQty,
        };
        if (isReadyPlantsOrder) {
          slotInc[
            "subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants"
          ] = -slotReleaseQty;
        } else if (!isSowingAllowed) {
          slotInc[
            "subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants"
          ] = slotReleaseQty;
        }

        await PlantSlot.updateOne(
          { "subtypeSlots.slots._id": order.bookingSlot },
          { $inc: slotInc },
          {
            arrayFilters: [
              { "subtypeSlot.slots._id": order.bookingSlot },
              { "slot._id": order.bookingSlot },
            ],
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

// ── assignRoute ───────────────────────────────────────────────────────────────
// PATCH /dispatch/assign-route
// Pre-dispatch step: assign a vehicle + driver to a planned set of orders.
// Also optionally marks those orders as READY_FOR_DISPATCH.
// ─────────────────────────────────────────────────────────────────────────────
const assignRoute = catchAsync(async (req, res, next) => {
  const {
    orderIds,          // required: array of Order ObjectIds
    vehicleId,         // optional: Vehicle CMS ObjectId
    driverId,          // optional: VehicleDriver ObjectId
    driverName: bodyDriverName,
    driverMobile: bodyDriverMobile,
    vehicleName: bodyVehicleName,
    vehicleNumber: bodyVehicleNumber,
    routeId,
    routeNotes,
    markReady = false, // if true → set READY_FOR_DISPATCH on FARM_READY orders
  } = req.body;

  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return next(new AppError("orderIds array is required", 400));
  }

  // Resolve vehicle + driver details from CMS when IDs are provided
  let resolvedDriverName = bodyDriverName || "";
  let resolvedDriverMobile = bodyDriverMobile || "";
  let resolvedVehicleName = bodyVehicleName || "";
  let resolvedVehicleNumber = bodyVehicleNumber || "";
  let resolvedVehicleId = null;
  let resolvedDriverId = null;

  if (vehicleId && mongoose.isValidObjectId(String(vehicleId))) {
    const vehicle = await Vehicle.findById(vehicleId).lean();
    if (vehicle) {
      resolvedVehicleId = vehicle._id;
      resolvedVehicleName = resolvedVehicleName || vehicle.name || "";
      resolvedVehicleNumber = resolvedVehicleNumber || vehicle.number || "";
      // If no explicit driverName, fall back to vehicle's default driver info
      if (!resolvedDriverName) {
        resolvedDriverName = vehicle.driverName || "";
        resolvedDriverMobile = resolvedDriverMobile || vehicle.driverMobile || "";
      }
    }
  }

  if (driverId && mongoose.isValidObjectId(String(driverId))) {
    const driver = await VehicleDriver.findById(driverId).lean();
    if (driver) {
      resolvedDriverId = driver._id;
      resolvedDriverName = resolvedDriverName || driver.name || "";
      resolvedDriverMobile = resolvedDriverMobile || driver.mobile || "";
    }
  }

  const assignedAt = new Date();
  const assignedBy = req.user?._id || null;

  // Bulk update all orders
  const updateOp = {
    $set: {
      assignedVehicle: resolvedVehicleNumber || resolvedVehicleName,
      ...(resolvedDriverName && { routeId: routeId || "" }),
      ...(routeId && { routeId }),
      assignedAt,
      ...(assignedBy && { assignedBy }),
    },
  };

  // When markReady=true, also move FARM_READY → READY_FOR_DISPATCH
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const validIds = orderIds
      .filter((id) => mongoose.isValidObjectId(String(id)))
      .map((id) => new mongoose.Types.ObjectId(String(id)));

    if (validIds.length === 0) {
      await session.abortTransaction();
      return next(new AppError("No valid order IDs provided", 400));
    }

    // Apply assignment to all orders
    await Order.updateMany(
      { _id: { $in: validIds } },
      updateOp,
      { session }
    );

    // Mark FARM_READY orders as READY_FOR_DISPATCH if requested
    let readyCount = 0;
    if (markReady) {
      const farmReadyOrders = await Order.find(
        { _id: { $in: validIds }, orderStatus: "FARM_READY" },
        "_id orderStatus"
      ).session(session).lean();

      for (const ord of farmReadyOrders) {
        await Order.findByIdAndUpdate(
          ord._id,
          appendStatusChangeToUpdate(
            { $set: { orderStatus: "READY_FOR_DISPATCH" } },
            ord.orderStatus,
            { userId: assignedBy, reason: "dispatch:assign_route_mark_ready" }
          ),
          { session }
        );
        readyCount++;
      }
    }

    await session.commitTransaction();

    res.status(200).json(
      generateResponse("Success", "Route assigned successfully", {
        assignedOrderCount: validIds.length,
        readyForDispatchCount: readyCount,
        vehicleName: resolvedVehicleName,
        vehicleNumber: resolvedVehicleNumber,
        driverName: resolvedDriverName,
        driverMobile: resolvedDriverMobile,
        vehicleId: resolvedVehicleId,
        driverId: resolvedDriverId,
        routeId: routeId || null,
      })
    );
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
});

// ── bulkMarkReady ─────────────────────────────────────────────────────────────
// PATCH /dispatch/bulk-mark-ready
// Move a batch of orders to READY_FOR_DISPATCH (from FARM_READY or any pre-dispatch status).
// ─────────────────────────────────────────────────────────────────────────────
const bulkMarkReady = catchAsync(async (req, res, next) => {
  const { orderIds } = req.body;

  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return next(new AppError("orderIds array is required", 400));
  }

  const validIds = orderIds
    .filter((id) => mongoose.isValidObjectId(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));

  if (validIds.length === 0) {
    return next(new AppError("No valid order IDs provided", 400));
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const eligibleOrders = await Order.find(
      { _id: { $in: validIds }, orderStatus: { $in: ["FARM_READY", "PROCESSING", "ACCEPTED"] } },
      "_id orderStatus"
    ).session(session).lean();

    let updatedCount = 0;
    for (const ord of eligibleOrders) {
      await Order.findByIdAndUpdate(
        ord._id,
        appendStatusChangeToUpdate(
          { $set: { orderStatus: "READY_FOR_DISPATCH" } },
          ord.orderStatus,
          { userId: req.user?._id, reason: "dispatch:bulk_mark_ready" }
        ),
        { session }
      );
      updatedCount++;
    }

    await session.commitTransaction();

    res.status(200).json(
      generateResponse("Success", "Orders marked as Ready for Dispatch", {
        requestedCount: validIds.length,
        updatedCount,
        skippedCount: validIds.length - eligibleOrders.length,
      })
    );
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
});

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
  addOrderToDispatch,
  getDispatches,
  getDispatch,
  removeTransport,
  assignRoute,
  bulkMarkReady,
};
