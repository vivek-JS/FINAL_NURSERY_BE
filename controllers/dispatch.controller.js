import generateResponse from "../utility/responseFormat.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import Dispatch from "../models/dispatch.model.js";
import Order from "../models/order.model.js";
import Farmer from "../models/farmer.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import ReadyDispatchGroup from "../models/readyDispatchGroup.model.js";
import PlantSlot from "../models/slots.model.js";
import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
import Tray from "../models/tray.model.js";
import Vehicle from "../models/vehicleModel.model.js";
import VehicleDriver from "../models/vehicleDriver.model.js";
import Trip from "../models/trip.model.js";
import {
  syncFarmerPlantLedgerForOrderUpdate,
  roundMoney,
  resolveFundingDealerId,
} from "../utils/farmerPlantOrderLedgerHelper.js";
import { releaseDealerQuotaPartial } from "./quota.controller.js";
import DealerWallet from "../models/dealerWallet.js";
import { appendStatusChangeToUpdate } from "../utils/orderStatusAuditHelper.js";
import Shade from "../models/shadeSchema.model.js";
import {
  applyWalletForDispatchNewPayments,
  buildDispatchCompletePaymentSubdocs,
  formatOrderWalletDescriptionContext,
  sumCollectedFromNewPaymentSubdocs,
} from "../utils/dispatchCompleteOrderPayments.js";
import { allocateNextInvoiceNumbers } from "../services/invoiceSequence.service.js";
import { ensureOfficialDeliveryChallanForOrder } from "../services/officialDeliveryChallan.service.js";
import { uploadToS3 } from "../services/uploadService.js";
import {
  buildDeliveryChallanPdfBuffer,
  buildCompleteInvoicePdfBuffer,
} from "../services/dispatchPdfDocuments.service.js";
import {
  getOrderUpdateUserContext,
  resolveUserForOrderUpdatePermissions,
} from "../utils/orderUpdatePermissions.js";
import {
  buildOrderEditHistoryFromDocDiff,
  mergeEditHistoryIntoFilteredBody,
  fireOrderEditWhatsAppAlerts,
} from "../utils/orderEditHistoryBuilder.js";
import {
  emitDispatchCompletedEvent,
  emitPlantOrderUpdateEvents,
} from "../utils/orderEventDualWrite.js";

const updateOrderWithLedgerSync = async ({
  orderId,
  updateOperation,
  session,
  userId,
  existingDoc,
  contextLabel = "dispatch_order_update",
  ledgerSyncOptions = {},
  /** Extra options for `findByIdAndUpdate` (e.g. `arrayFilters`). */
  mongooseUpdateOptions = {},
  /** Collect { previousOrder, updatedOrder, entries } for post-commit WhatsApp alerts */
  editAlertQueue = null,
  req = null,
}) => {
  const resolvedEditAlertQueue =
    editAlertQueue ?? req?._orderEditAlertQueue ?? null;
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

  const setFields = opWithAudit.$set || {};
  const previousPlain = previousOrder?.toObject?.() ?? previousOrder;
  const syntheticNext = { ...previousPlain, ...setFields };
  const dispatchHistoryEntries = buildOrderEditHistoryFromDocDiff(
    previousPlain,
    syntheticNext,
    {
      userId,
      reasonPrefix: contextLabel ? `dispatch:${contextLabel}` : "dispatch",
    }
  );
  if (dispatchHistoryEntries.length > 0) {
    mergeEditHistoryIntoFilteredBody(opWithAudit, dispatchHistoryEntries);
  }

  const updatedOrder = await Order.findByIdAndUpdate(orderId, opWithAudit, {
    new: true,
    runValidators: true,
    session,
    ...mongooseUpdateOptions,
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

  if (dispatchHistoryEntries.length > 0 && resolvedEditAlertQueue) {
    resolvedEditAlertQueue.push({
      previousOrder: previousPlain,
      updatedOrder,
      entries: dispatchHistoryEntries,
    });
  }

  const dispatchPush = opWithAudit.$push?.dispatchHistory;
  const dispatchEntry =
    dispatchPush && typeof dispatchPush === "object" && !dispatchPush.$each
      ? dispatchPush
      : null;

  emitPlantOrderUpdateEvents({
    orderId: updatedOrder._id,
    editHistoryEntries: dispatchHistoryEntries,
    userId,
    actorName: req?.user?.name,
  }).catch((e) => console.error("[OrderEvent] dispatch edit emit:", e?.message || e));

  if (dispatchEntry) {
    emitDispatchCompletedEvent(updatedOrder._id, dispatchEntry, {
      userId,
      actorName: req?.user?.name,
    }).catch((e) => console.error("[OrderEvent] dispatch complete emit:", e?.message || e));
  }

  return updatedOrder;
};

const isDispatchedTransition = (previousStatus, nextStatus) =>
  String(previousStatus || "").toUpperCase() !== "DISPATCHED" &&
  String(nextStatus || "").toUpperCase() === "DISPATCHED";

const queueDispatchedOrderAlert = ({
  queue,
  previousOrder,
  updatedOrder,
  changedBy,
  allowedOrderIds = null,
}) => {
  if (!queue || !previousOrder || !updatedOrder) return;
  if (!isDispatchedTransition(previousOrder?.orderStatus, updatedOrder?.orderStatus)) return;
  const oid = String(updatedOrder?._id || previousOrder?._id || "").trim();
  if (!oid || queue.has(oid)) return;
  if (allowedOrderIds && !allowedOrderIds.has(oid)) return;
  const plain = updatedOrder?.toObject ? updatedOrder.toObject() : updatedOrder;
  queue.set(oid, {
    order: plain,
    changedBy: changedBy || "Unknown",
  });
};

const fireQueuedDispatchedOrderAlerts = (queue) => {
  if (!queue || queue.size === 0) return;
  const items = Array.from(queue.values());
  (async () => {
    try {
      const { sendOrderDispatchedAlert } = await import("../services/whatsappAlertService.js");
      for (const item of items) {
        await sendOrderDispatchedAlert(item.order, item.changedBy);
      }
    } catch (e) {
      console.error("whatsapp-alert dispatch DISPATCHED transition:", e?.message || e);
    }
  })();
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

/** Same rules as `getDispatchLoadStatus` in agriSalesOrder.controller — clear only when LOADED. */
const linkedAgriLoadSatisfiedForNursery = (order) => {
  const load = String(order?.agriLoadStatus || "").toUpperCase();
  return load === "LOADED";
};

const getPendingLinkedAgriLoads = async (orderIds = []) => {
  const normalizedOrderIds = (Array.isArray(orderIds) ? orderIds : [])
    .filter((id) => mongoose.isValidObjectId(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!normalizedOrderIds.length) {
    return [];
  }

  const candidates = await AgriSalesOrder.find({
    linkedNurseryOrderId: { $in: normalizedOrderIds },
    orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
  })
    .select(
      "orderNumber linkedNurseryOrderCode customerName productName quantity lineItems agriLoadStatus dispatchStatus orderStatus"
    )
    .lean();

  return candidates.filter((o) => !linkedAgriLoadSatisfiedForNursery(o));
};

const markLinkedAgriLoadedForDispatch = async ({
  orderIds = [],
  user = null,
  dispatchRequest = {},
  dispatchId = null,
  session = null,
}) => {
  const normalizedOrderIds = (Array.isArray(orderIds) ? orderIds : [])
    .filter((id) => mongoose.isValidObjectId(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!normalizedOrderIds.length) return;

  const linkedOrders = await AgriSalesOrder.find({
    linkedNurseryOrderId: { $in: normalizedOrderIds },
    orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
  }).session(session);

  if (!linkedOrders.length) return;

  const performedBy = user?._id || user?.id || null;
  const performedByName = user?.name || "Unknown";

  for (const linkedOrder of linkedOrders) {
    if (linkedAgriLoadSatisfiedForNursery(linkedOrder)) continue;
    linkedOrder.agriLoadStatus = "LOADED";
    linkedOrder.loadedAt = new Date();
    linkedOrder.loadedBy = performedBy;
    if (!Array.isArray(linkedOrder.activityLog)) linkedOrder.activityLog = [];
    linkedOrder.activityLog.push({
      action: "DISPATCH_UPDATED",
      description: `Auto-marked LOADED from plant dispatch${dispatchId ? ` #${dispatchId}` : ""}.`,
      performedBy,
      performedByName,
      metadata: {
        agriLoadStatus: "LOADED",
        loadedAt: linkedOrder.loadedAt,
        source: "PLANT_DISPATCH",
        dispatchId: dispatchId || null,
        driverName: dispatchRequest?.driverName || "",
        driverMobile: dispatchRequest?.driverMobile || "",
        vehicleName: dispatchRequest?.vehicleName || "",
      },
    });
    await linkedOrder.save({ session });
  }
};

const createDispatch = catchAsync(async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  req._orderEditAlertQueue = [];
  const voiceFeedbackOrderIds = [];
  const dispatchedAlertQueue = new Map();

  try {
    const dispatchRequest = { ...req.body };
    const expectedNurseryGlobal =
      dispatchRequest.expectedNursery != null &&
      String(dispatchRequest.expectedNursery).trim() !== ""
        ? String(dispatchRequest.expectedNursery).trim()
        : "";
    if (dispatchRequest.expectedNursery !== undefined) {
      delete dispatchRequest.expectedNursery;
    }
    // Always keep linked Ram Agri loading as an explicit/manual step.
    // Plant dispatch must not auto-flip agriLoadStatus to LOADED.
    const autoMarkLinkedAgriLoaded = false;
    if (dispatchRequest.autoMarkLinkedAgriLoaded !== undefined) {
      delete dispatchRequest.autoMarkLinkedAgriLoaded;
    }
    const readyDispatchGroupId = dispatchRequest.readyDispatchGroupId;
    if (readyDispatchGroupId !== undefined) {
      delete dispatchRequest.readyDispatchGroupId;
    }

    if (
      readyDispatchGroupId &&
      mongoose.isValidObjectId(String(readyDispatchGroupId))
    ) {
      const fleetGroup = await ReadyDispatchGroup.findById(readyDispatchGroupId).lean();
      if (fleetGroup) {
        if (!dispatchRequest.vehicleId && fleetGroup.vehicleId) {
          dispatchRequest.vehicleId = fleetGroup.vehicleId;
        }
        if (!dispatchRequest.driverId && fleetGroup.driverId) {
          dispatchRequest.driverId = fleetGroup.driverId;
        }
        if (!dispatchRequest.ownerId && fleetGroup.ownerId) {
          dispatchRequest.ownerId = fleetGroup.ownerId;
        }
        dispatchRequest.vehicleName =
          dispatchRequest.vehicleName || fleetGroup.vehicleName || "";
        dispatchRequest.vehicleNumber =
          dispatchRequest.vehicleNumber || fleetGroup.vehicleNumber || "";
        dispatchRequest.driverName =
          dispatchRequest.driverName || fleetGroup.driverName || "";
        dispatchRequest.driverMobile =
          dispatchRequest.driverMobile || fleetGroup.driverMobile || "";
        dispatchRequest.routeId =
          dispatchRequest.routeId || fleetGroup.routeId || "";
        dispatchRequest.routeNotes =
          dispatchRequest.routeNotes || fleetGroup.routeNotes || "";
        dispatchRequest.driverRemark =
          dispatchRequest.driverRemark || fleetGroup.driverRemark || "";
        dispatchRequest.vehicleRemark =
          dispatchRequest.vehicleRemark || fleetGroup.vehicleRemark || "";
        if (!dispatchRequest.name?.trim()) {
          dispatchRequest.name =
            fleetGroup.notes?.trim() || fleetGroup.groupCode || "";
        }
      }
    }

    // ── Auto-populate driverName / vehicleName from CMS when IDs are provided ──
    if (dispatchRequest.vehicleId && mongoose.isValidObjectId(String(dispatchRequest.vehicleId))) {
      const vehicle = await Vehicle.findById(dispatchRequest.vehicleId).lean();
      if (vehicle) {
        dispatchRequest.vehicleName = dispatchRequest.vehicleName || vehicle.name || "";
        dispatchRequest.vehicleNumber = dispatchRequest.vehicleNumber || vehicle.number || "";
        if (!dispatchRequest.ownerId && vehicle.ownerId) {
          dispatchRequest.ownerId = vehicle.ownerId;
        }
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
    const pendingLinkedAgriOrders = await getPendingLinkedAgriLoads(dispatchRequest.orderIds);
    const pendingLinkedNurseryOrderIds = new Set(
      pendingLinkedAgriOrders
        .map((o) => String(o?.linkedNurseryOrderId || "").trim())
        .filter(Boolean)
    );
    dispatchRequest.transportId = await generateTransportId();

    const dispatch = await Dispatch.create([dispatchRequest], { session });

    const splitDetails = Array.isArray(dispatchRequest.orderDispatchDetails)
      ? dispatchRequest.orderDispatchDetails
      : [];

    const ordersForSplit = [];
    for (const od of splitDetails) {
      ordersForSplit.push(await Order.findById(od.orderId).session(session));
    }

    // Handle partial/split dispatches if orderDispatchDetails is provided
    if (splitDetails.length > 0) {
      // Update each order individually with dispatch details
      for (let i = 0; i < splitDetails.length; i++) {
        const orderDispatch = splitDetails[i];
        const order = ordersForSplit[i];

        if (!order) {
          throw new AppError(`Order not found: ${orderDispatch.orderId}`, 404);
        }

        // Validate dispatch quantity
        const currentRemaining = orderRemainingOrBookable(order);
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
          voiceFeedbackOrderIds.push(orderDispatch.orderId);
        } else if (newRemainingPlants < currentRemaining) {
          // Partially dispatched
          newStatus = "DISPATCH_PROCESS";
        }

        const preAssigned = String(order.deliveryChallanInvoiceNumber || "").trim();
        let official = null;
        let legInvoice = "";
        if (newStatus === "DISPATCHED" && newRemainingPlants === 0) {
          official = await ensureOfficialDeliveryChallanForOrder(order, session);
        }
        if (official) {
          legInvoice = official;
        } else {
          legInvoice = preAssigned;
          if (!legInvoice) {
            const [g] = await allocateNextInvoiceNumbers(session, 1);
            legInvoice = g || "";
          }
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
          ...(legInvoice ? { invoiceNumber: legInvoice } : {}),
        };

        const setFields = {
          remainingPlants: newRemainingPlants,
          orderStatus: newStatus,
          currentDispatchId: dispatch[0]._id, // Set the current dispatch reference
          ...(expectedNurseryGlobal ? { expectedNursery: expectedNurseryGlobal } : {}),
        };
        if (official) {
          setFields.officialDeliveryChallanNumber = official;
        }
        if (!preAssigned && legInvoice && !official) {
          setFields.deliveryChallanInvoiceNumber = legInvoice;
        }

        // Update the order
        const updatedOrder = await updateOrderWithLedgerSync({
          orderId: orderDispatch.orderId,
          existingDoc: order,
          updateOperation: {
            $set: setFields,
            $push: {
              dispatchHistory: dispatchHistoryEntry,
            },
          },
          session,
          userId: req.user?._id,
          req,
          contextLabel: "create_dispatch_split_update",
        });
        queueDispatchedOrderAlert({
          queue: dispatchedAlertQueue,
          previousOrder: order,
          updatedOrder,
          changedBy: req.user?.name || req.user?.email || "Unknown",
          allowedOrderIds: pendingLinkedNurseryOrderIds,
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
            ...(expectedNurseryGlobal ? { expectedNursery: expectedNurseryGlobal } : {}),
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

    if (autoMarkLinkedAgriLoaded && pendingLinkedAgriOrders.length > 0) {
      await markLinkedAgriLoadedForDispatch({
        orderIds: dispatchRequest.orderIds,
        user: req.user,
        dispatchRequest,
        dispatchId: dispatch[0]._id,
        session,
      });
    }

    await session.commitTransaction();
    fireQueuedDispatchedOrderAlerts(dispatchedAlertQueue);
    fireOrderEditWhatsAppAlerts(
      req._orderEditAlertQueue,
      req.user?.name || req.user?.email || "Unknown"
    );
    delete req._orderEditAlertQueue;

    if (voiceFeedbackOrderIds.length > 0) {
      (async () => {
        try {
          const { ensureFeedbackCallForOrder } = await import("../services/feedbackCallScheduling.js");
          for (const oid of voiceFeedbackOrderIds) {
            const o = await Order.findById(oid).lean();
            if (o) await ensureFeedbackCallForOrder(o, { isInstantDispatch: false });
          }
        } catch (e) {
          console.error("voice-feedback dispatch createDispatch:", e?.message || e);
        }
      })();
    }

    // WhatsApp dispatch alert — fire-and-forget, never blocks the API response
    (async () => {
      try {
        const { sendLinkedAgriAlert } = await import("../services/whatsappAlertService.js");

        // Resolve farmer / customer names from the dispatched order IDs
        const allOrderIds = dispatchRequest.orderIds || [];
        const farmerNames = [];
        for (const oid of allOrderIds) {
          try {
            const o = await Order.findById(oid)
              .populate("farmer", "name")
              .populate("salesPerson", "name")
              .lean();
            if (!o) continue;
            const name =
              o?.farmer?.name ||
              o?.orderFor?.name ||
              o?.salesPerson?.name ||
              String(oid);
            if (name) farmerNames.push(name);
          } catch (_) { /* skip individual lookup failure */ }
        }

        const dispatchDocForAlert = dispatch[0]?.toObject ? dispatch[0].toObject() : dispatch[0];
        const resolvedVehicleName =
          dispatchRequest.vehicleName || dispatchDocForAlert?.vehicleName || "";
        const resolvedVehicleNumber =
          dispatchRequest.vehicleNumber || dispatchDocForAlert?.vehicleNumber || "";
        const resolvedDriverName =
          dispatchRequest.driverName || dispatchDocForAlert?.driverName || "";
        const resolvedDriverMobile =
          dispatchRequest.driverMobile || dispatchDocForAlert?.driverMobile || "";

        // Linked Ram Agri inputs are manual: send one-click "mark loaded" alert while pending.
        if (pendingLinkedAgriOrders.length > 0) {
          const products = [
            ...new Set(
              pendingLinkedAgriOrders
                .map((o) => o?.productName || o?.lineItems?.[0]?.name || "")
                .filter(Boolean)
            ),
          ];
          const linkedOrders = pendingLinkedAgriOrders.map((o) => ({
            orderNumber: o?.orderNumber,
            linkedNurseryOrderCode: o?.linkedNurseryOrderCode,
            linkedNurseryOrderId: o?.linkedNurseryOrderId,
            productName: o?.productName,
            ramAgriVarietyName: o?.ramAgriVarietyName,
            subtypeName: o?.subtypeName,
            quantity: o?.quantity,
            deliveredQuantity: o?.deliveredQuantity,
            lineItems: Array.isArray(o?.lineItems)
              ? o.lineItems.map((li) => ({
                  name: li?.name,
                productName: li?.productName,
                ramAgriVarietyName: li?.ramAgriVarietyName,
                subtypeName: li?.subtypeName,
                subtype: li?.subtype,
                type: li?.type,
                  quantity: li?.quantity ?? li?.qty ?? li?.requestedQuantity,
                }))
              : [],
          }));
          await sendLinkedAgriAlert({
            linkedCount: pendingLinkedAgriOrders.length,
            products,
            linkedOrders,
            vehicleName: resolvedVehicleName,
            vehicleNumber: resolvedVehicleNumber,
            driverName: resolvedDriverName,
            loadedBy: req.user?.name || req.user?.email || "Unknown",
          });
        }
      } catch (e) {
        console.error("whatsapp-alert dispatch createDispatch:", e?.message || e);
      }
    })();

    const dispatchDoc = dispatch[0]?.toObject ? dispatch[0].toObject() : dispatch[0];
    const stillPendingLinkedAgri =
      pendingLinkedAgriOrders.length > 0 && !autoMarkLinkedAgriLoaded;
    const warningOrderRefs = Array.from(
      new Set(
        (stillPendingLinkedAgri ? pendingLinkedAgriOrders : [])
          .map((o) => String(o?.linkedNurseryOrderCode || o?.linkedNurseryOrderId || "").trim())
          .filter(Boolean)
      )
    );
    const responsePayload = {
      ...dispatchDoc,
      linkedAgriLoadWarning:
        stillPendingLinkedAgri
          ? {
              isPending: true,
              pendingCount: pendingLinkedAgriOrders.length,
              linkedNurseryOrderRefs: warningOrderRefs,
              message:
                "Dispatch created. Linked Agri Inputs are still pending load from Ram Agri dispatch flow; resolve from Agri Inputs dashboard.",
            }
          : {
              isPending: false,
              pendingCount: 0,
              linkedNurseryOrderRefs: [],
            },
    };

    res.status(201).json(
      generateResponse(
        "Success",
        "Dispatch created successfully and orders updated",
        responsePayload
      )
    );
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});

const bookablePlantsTotal = (order) =>
  Number(order?.numberOfPlants || 0) + Number(order?.additionalPlants || 0);

const orderRemainingOrBookable = (order) => {
  const rem = order?.remainingPlants;
  if (rem != null && Number.isFinite(Number(rem))) return Number(rem);
  return bookablePlantsTotal(order);
};

/** Remaining plants after nursery dispatch leg: 0 = fully out, full bookable = ready queue. */
const orderStatusFromRemaining = (order, remaining) => {
  const r = Number(remaining);
  if (!Number.isFinite(r) || r < 0) {
    throw new AppError("Invalid remaining plants on order after dispatch update", 400);
  }
  if (r === 0) return "DISPATCHED";
  const total = bookablePlantsTotal(order);
  if (r > total) {
    throw new AppError(
      `Remaining plants (${r}) exceeds bookable total (${total}) for order ${order?.orderId ?? ""}`,
      400
    );
  }
  if (r >= total) return "READY_FOR_DISPATCH";
  return "DISPATCH_PROCESS";
};

const computeCurrentDispatchIdAfterHistoryChange = (historyArray, dispatchOid) => {
  const hist = Array.isArray(historyArray)
    ? historyArray.filter(
        (e) => e?.dispatchId && String(e.dispatchId) !== String(dispatchOid)
      )
    : [];
  if (!hist.length) return null;
  const latest = hist.reduce((best, cur) => {
    const bd = new Date(best?.date || 0).getTime();
    const cd = new Date(cur?.date || 0).getTime();
    return cd >= bd ? cur : best;
  });
  return latest?.dispatchId || null;
};

const normalizePlantsDetailsBody = (plantsDetailsRaw) => {
  if (!Array.isArray(plantsDetailsRaw)) return null;
  return plantsDetailsRaw.map((plant) => ({
    ...plant,
    totalPlants: plant.pickupDetails.reduce(
      (sum, detail) => sum + detail.quantity,
      0
    ),
    pickupDetails: plant.pickupDetails.map((pickup) => ({
      ...pickup,
      cavity:
        typeof pickup.cavity === "string"
          ? new mongoose.Types.ObjectId(pickup.cavity)
          : pickup.cavity,
    })),
    crates: plant.crates.map((crate) => ({
      ...crate,
      cavity:
        typeof crate.cavity === "string"
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
  }));
};

const normalizeCellToOrderIdString = (cell) => {
  if (cell == null) return "";
  if (typeof cell === "object" && cell._id != null) return String(cell._id);
  return String(cell);
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Shown when :id does not resolve to an active dispatch document. */
const DISPATCH_LOOKUP_NOT_FOUND =
  "No active dispatch matches this id. Use the dispatch _id or transportId from the vehicles list, or an order id on that vehicle. Removed vehicles are not available.";

/**
 * Resolve a dispatch by Mongo `_id`, `transportId`, or an order `_id` on that vehicle
 * (clients sometimes pass order id). Excludes soft-deleted rows — same scope as GET list.
 */
const findDispatchDocumentFlexible = async (idParam, session = null) => {
  let raw = String(idParam ?? "").trim();
  if (!raw) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* ignore */
  }

  const withSession = (q) => (session ? q.session(session) : q);
  const active = { isDeleted: { $ne: true } };

  let doc = await withSession(Dispatch.findById(raw));
  if (doc?.isDeleted) doc = null;
  if (doc) return doc;

  doc = await withSession(Dispatch.findOne({ transportId: raw, ...active }));
  if (doc) return doc;

  doc = await withSession(
    Dispatch.findOne({
      transportId: new RegExp(`^${escapeRegex(raw)}$`, "i"),
      ...active,
    })
  );
  if (doc) return doc;

  doc = await withSession(Dispatch.findOne({ routeId: raw, ...active }));
  if (doc) return doc;

  if (mongoose.isValidObjectId(raw)) {
    const oid = new mongoose.Types.ObjectId(raw);
    doc = await withSession(
      Dispatch.findOne({
        ...active,
        $or: [{ orderIds: oid }, { afterDispatchedOrderIds: oid }],
      })
    );
  }

  return doc || null;
};

// Update dispatch controller — keeps Order docs in sync (remaining, history, status, ledger).
const updateDispatch = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const rawBody = { ...req.body };
  if (rawBody.transportId) {
    delete rawBody.transportId;
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  const dispatchedAlertQueue = new Map();
  req._orderEditAlertQueue = [];

  try {
    const existing = await findDispatchDocumentFlexible(id, session);
    if (!existing) {
      throw new AppError(DISPATCH_LOOKUP_NOT_FOUND, 404);
    }
    const dispatchOid = existing._id;
    const pendingLinkedAgriOrders = await getPendingLinkedAgriLoads(existing.orderIds || []);
    const pendingLinkedNurseryOrderIds = new Set(
      pendingLinkedAgriOrders
        .map((o) => String(o?.linkedNurseryOrderId || "").trim())
        .filter(Boolean)
    );

    if (existing.transportStatus === "DELIVERED") {
      const risky = ["orderIds", "orderDispatchDetails", "plantsDetails", "afterDispatchedOrderIds"];
      const touched = risky.filter((k) => rawBody[k] !== undefined);
      if (touched.length) {
        throw new AppError(
          "Cannot change orders or plant loads on a delivered dispatch. Only metadata (name / driver / vehicle) is allowed.",
          400
        );
      }
    }

    const raw = { ...rawBody };
    if (raw.plantsDetails) {
      raw.plantsDetails = normalizePlantsDetailsBody(raw.plantsDetails);
      validateQuantities(raw.plantsDetails);
    }

    const oldOrderIds = (existing.orderIds || []).map((x) => String(x));

    const oldDetailsByOrder = new Map();
    (existing.orderDispatchDetails || []).forEach((row) => {
      if (row?.orderId) {
        oldDetailsByOrder.set(String(row.orderId), Number(row.dispatchQuantity) || 0);
      }
    });

    if (!oldDetailsByOrder.size && oldOrderIds.length) {
      for (const oidStr of oldOrderIds) {
        const o = await Order.findById(oidStr).session(session);
        if (!o) continue;
        const entry = (o.dispatchHistory || []).find(
          (h) => h?.dispatchId && String(h.dispatchId) === String(dispatchOid)
        );
        if (entry) {
          oldDetailsByOrder.set(oidStr, Number(entry.quantity) || 0);
        }
      }
    }

    const inferredFromDetails = Array.isArray(raw.orderDispatchDetails)
      ? [
          ...new Set(
            raw.orderDispatchDetails
              .map((r) => (r?.orderId != null ? String(r.orderId) : ""))
              .filter((s) => mongoose.isValidObjectId(s))
          ),
        ]
      : [];

    const normalizedFromBody = Array.isArray(raw.orderIds)
      ? raw.orderIds
          .map(normalizeCellToOrderIdString)
          .filter((s) => mongoose.isValidObjectId(s))
      : null;

    const effectiveNewIds =
      normalizedFromBody !== null
        ? normalizedFromBody
        : inferredFromDetails.length
        ? inferredFromDetails
        : [...oldOrderIds];

    const newDetailsByOrder = new Map();
    if (Array.isArray(raw.orderDispatchDetails)) {
      raw.orderDispatchDetails.forEach((row) => {
        if (row?.orderId != null) {
          newDetailsByOrder.set(
            String(row.orderId),
            Number(row.dispatchQuantity) || 0
          );
        }
      });
    }

    const newIdSet = new Set(effectiveNewIds);
    const oldIdSet = new Set(oldOrderIds);

    // --- Empty roster: delete dispatch and revert all orders tied to it ---
    if (!effectiveNewIds.length) {
      const revertIds = [...new Set([...oldOrderIds])];
      for (const oidStr of revertIds) {
        const order = await Order.findById(oidStr).session(session);
        if (!order) continue;
        const entry = (order.dispatchHistory || []).find(
          (h) => h?.dispatchId && String(h.dispatchId) === String(dispatchOid)
        );
        if (entry) {
          const restored =
            orderRemainingOrBookable(order) + (Number(entry.quantity) || 0);
          const nextStatus = orderStatusFromRemaining(order, restored);
          const histAfter = (order.dispatchHistory || []).filter(
            (h) =>
              !h?.dispatchId || String(h.dispatchId) !== String(dispatchOid)
          );
          const nextCurrent =
            String(order.currentDispatchId || "") === String(dispatchOid)
              ? computeCurrentDispatchIdAfterHistoryChange(histAfter, dispatchOid)
              : order.currentDispatchId;

          await updateOrderWithLedgerSync({
            orderId: oidStr,
            existingDoc: order,
            session,
            userId: req.user?._id,
          req,
            contextLabel: "update_dispatch_delete_all_revert",
            updateOperation: {
              $set: {
                remainingPlants: restored,
                orderStatus: nextStatus,
                currentDispatchId: nextCurrent,
              },
              $pull: { dispatchHistory: { dispatchId: dispatchOid } },
            },
          });
        } else if (String(order.currentDispatchId || "") === String(dispatchOid)) {
          await updateOrderWithLedgerSync({
            orderId: oidStr,
            existingDoc: order,
            session,
            userId: req.user?._id,
          req,
            contextLabel: "update_dispatch_delete_all_clear_current",
            updateOperation: {
              $set: {
                currentDispatchId: null,
                orderStatus: "READY_FOR_DISPATCH",
              },
            },
          });
        }
      }

      await Dispatch.deleteOne({ _id: dispatchOid }).session(session);
      await session.commitTransaction();
      return res.status(200).json(
        generateResponse("Success", "Dispatch removed (no orders left)", {
          deleted: true,
          dispatchId: String(dispatchOid),
        })
      );
    }

    // --- Removed orders ---
    for (const oldId of oldOrderIds) {
      if (newIdSet.has(oldId)) continue;
      const order = await Order.findById(oldId).session(session);
      if (!order) continue;
      const entry = (order.dispatchHistory || []).find(
        (h) => h?.dispatchId && String(h.dispatchId) === String(dispatchOid)
      );
      const fallbackQty = oldDetailsByOrder.get(oldId) || 0;
      const qty = entry ? Number(entry.quantity) || 0 : fallbackQty;

      if (!entry && !qty) {
        if (String(order.currentDispatchId || "") === String(dispatchOid)) {
          await updateOrderWithLedgerSync({
            orderId: oldId,
            existingDoc: order,
            session,
            userId: req.user?._id,
          req,
            contextLabel: "update_dispatch_remove_order_no_hist",
            updateOperation: {
              $set: {
                currentDispatchId: null,
                orderStatus: "READY_FOR_DISPATCH",
              },
            },
          });
        }
        continue;
      }

      const restored = orderRemainingOrBookable(order) + qty;
      const nextStatus = orderStatusFromRemaining(order, restored);
      const histAfter = (order.dispatchHistory || []).filter(
        (h) => !h?.dispatchId || String(h.dispatchId) !== String(dispatchOid)
      );
      const nextCurrent =
        String(order.currentDispatchId || "") === String(dispatchOid)
          ? computeCurrentDispatchIdAfterHistoryChange(histAfter, dispatchOid)
          : order.currentDispatchId;

      await updateOrderWithLedgerSync({
        orderId: oldId,
        existingDoc: order,
        session,
        userId: req.user?._id,
          req,
        contextLabel: "update_dispatch_remove_order",
        updateOperation: entry
          ? {
              $set: {
                remainingPlants: restored,
                orderStatus: nextStatus,
                currentDispatchId: nextCurrent,
              },
              $pull: { dispatchHistory: { dispatchId: dispatchOid } },
            }
          : {
              $set: {
                remainingPlants: restored,
                orderStatus: nextStatus,
                currentDispatchId: nextCurrent,
              },
            },
      });
    }

    // --- New orders added on edit ---
    const newlyAddedOrderIds = effectiveNewIds.filter((id) => !oldIdSet.has(id));
    const newOrderDocs = await Promise.all(
      newlyAddedOrderIds.map((nid) => Order.findById(nid).session(session))
    );
    const newOrderById = new Map(
      newlyAddedOrderIds.map((id, idx) => [String(id), newOrderDocs[idx]])
    );

    for (const newId of effectiveNewIds) {
      if (oldIdSet.has(newId)) continue;
      const newQty = newDetailsByOrder.get(newId);
      if (!newQty || newQty <= 0) {
        throw new AppError(
          `dispatchQuantity is required for newly added order ${newId}`,
          400
        );
      }
      const order = newOrderById.get(String(newId));
      if (!order) throw new AppError(`Order not found: ${newId}`, 404);
      const currentRemaining = orderRemainingOrBookable(order);
      if (newQty > currentRemaining) {
        throw new AppError(
          `Dispatch quantity (${newQty}) exceeds remaining plants (${currentRemaining}) for order ${order.orderId}`,
          400
        );
      }
      const newRemaining = currentRemaining - newQty;
      const newStatus = orderStatusFromRemaining(order, newRemaining);
      const preAssignedInv = String(order.deliveryChallanInvoiceNumber || "").trim();
      let official = null;
      let legInvoice = "";
      if (newStatus === "DISPATCHED" && newRemaining === 0) {
        official = await ensureOfficialDeliveryChallanForOrder(order, session);
      }
      if (official) {
        legInvoice = official;
      } else {
        legInvoice = preAssignedInv;
        if (!legInvoice) {
          const [g] = await allocateNextInvoiceNumbers(session, 1);
          legInvoice = g || "";
        }
      }
      const dispatchHistoryEntry = {
        date: new Date(),
        quantity: newQty,
        dispatchId: dispatchOid,
        remainingAfterDispatch: newRemaining,
        processedBy: req.user ? req.user._id : null,
        driverName: raw.driverName ?? existing.driverName ?? "",
        vehicleName: raw.vehicleName ?? existing.vehicleName ?? "",
        ...(legInvoice ? { invoiceNumber: legInvoice } : {}),
      };
      const setUpdateDispatchAdd = {
        remainingPlants: newRemaining,
        orderStatus: newStatus,
        currentDispatchId: dispatchOid,
      };
      if (official) {
        setUpdateDispatchAdd.officialDeliveryChallanNumber = official;
      }
      if (!preAssignedInv && legInvoice && !official) {
        setUpdateDispatchAdd.deliveryChallanInvoiceNumber = legInvoice;
      }
      const updatedOrder = await updateOrderWithLedgerSync({
        orderId: newId,
        existingDoc: order,
        session,
        userId: req.user?._id,
          req,
        contextLabel: "update_dispatch_add_order",
        updateOperation: {
          $set: setUpdateDispatchAdd,
          $push: { dispatchHistory: dispatchHistoryEntry },
        },
      });
      queueDispatchedOrderAlert({
        queue: dispatchedAlertQueue,
        previousOrder: order,
        updatedOrder,
        changedBy: req.user?.name || req.user?.email || "Unknown",
        allowedOrderIds: pendingLinkedNurseryOrderIds,
      });
    }

    // --- Kept orders: quantity adjustments for this dispatch ---
    for (const oidStr of effectiveNewIds) {
      if (!oldIdSet.has(oidStr)) continue;
      const newQty = newDetailsByOrder.get(oidStr);
      if (newQty == null) continue;
      const oldQty = oldDetailsByOrder.get(oidStr) ?? 0;
      const delta = newQty - oldQty;
      if (delta === 0) continue;

      const order = await Order.findById(oidStr).session(session);
      if (!order) throw new AppError(`Order not found: ${oidStr}`, 404);
      const entry = (order.dispatchHistory || []).find(
        (h) => h?.dispatchId && String(h.dispatchId) === String(dispatchOid)
      );
      if (!entry) {
        throw new AppError(
          `Cannot adjust dispatch quantity: no dispatch history for order ${oidStr} on this dispatch`,
          400
        );
      }

      const currentRemaining = orderRemainingOrBookable(order);
      if (delta > 0 && delta > currentRemaining) {
        throw new AppError(
          `Increase of ${delta} exceeds remaining plants (${currentRemaining}) for order ${order.orderId}`,
          400
        );
      }
      const newRemaining = currentRemaining - delta;
      const newStatus = orderStatusFromRemaining(order, newRemaining);

      let official = null;
      if (newStatus === "DISPATCHED" && newRemaining === 0) {
        official = await ensureOfficialDeliveryChallanForOrder(order, session);
      }
      let fallbackLegInvoice = "";
      if (newStatus === "DISPATCHED" && newRemaining === 0 && !official) {
        const [g] = await allocateNextInvoiceNumbers(session, 1);
        fallbackLegInvoice = g || "";
      }

      const nextHist = (order.dispatchHistory || []).map((h) => {
        const plain = h?.toObject ? h.toObject() : { ...h };
        if (String(plain.dispatchId) !== String(dispatchOid)) return plain;
        const inv =
          official ||
          plain.invoiceNumber ||
          String(order.deliveryChallanInvoiceNumber || "").trim() ||
          fallbackLegInvoice ||
          "";
        return {
          ...plain,
          quantity: newQty,
          remainingAfterDispatch: newRemaining,
          driverName:
            raw.driverName ?? existing.driverName ?? plain.driverName ?? "",
          vehicleName:
            raw.vehicleName ?? existing.vehicleName ?? plain.vehicleName ?? "",
          ...(inv ? { invoiceNumber: inv } : {}),
        };
      });

      const nextCurrent =
        String(order.currentDispatchId || "") === String(dispatchOid)
          ? dispatchOid
          : order.currentDispatchId;

      const setPayload = {
        dispatchHistory: nextHist,
        remainingPlants: newRemaining,
        orderStatus: newStatus,
        currentDispatchId: nextCurrent,
      };
      if (official) {
        setPayload.officialDeliveryChallanNumber = official;
      }
      if (
        !official &&
        fallbackLegInvoice &&
        !String(order.deliveryChallanInvoiceNumber || "").trim()
      ) {
        setPayload.deliveryChallanInvoiceNumber = fallbackLegInvoice;
      }

      const updatedOrder = await updateOrderWithLedgerSync({
        orderId: oidStr,
        existingDoc: order,
        session,
        userId: req.user?._id,
          req,
        contextLabel: "update_dispatch_qty_change",
        updateOperation: {
          $set: setPayload,
        },
      });
      queueDispatchedOrderAlert({
        queue: dispatchedAlertQueue,
        previousOrder: order,
        updatedOrder,
        changedBy: req.user?.name || req.user?.email || "Unknown",
        allowedOrderIds: pendingLinkedNurseryOrderIds,
      });
    }

    const nextOrderDispatchDetails =
      raw.orderDispatchDetails != null
        ? raw.orderDispatchDetails.filter((d) => newIdSet.has(String(d.orderId)))
        : (existing.orderDispatchDetails || []).filter((d) =>
            newIdSet.has(String(d.orderId))
          );

    const setPayload = {
      orderIds: effectiveNewIds.map((s) => new mongoose.Types.ObjectId(s)),
      orderDispatchDetails: nextOrderDispatchDetails,
      ...(raw.name !== undefined ? { name: raw.name } : {}),
      ...(raw.driverName !== undefined ? { driverName: raw.driverName } : {}),
      ...(raw.driverMobile !== undefined ? { driverMobile: raw.driverMobile } : {}),
      ...(raw.vehicleName !== undefined ? { vehicleName: raw.vehicleName } : {}),
      ...(raw.vehicleNumber !== undefined ? { vehicleNumber: raw.vehicleNumber } : {}),
      ...(raw.vehicleId !== undefined ? { vehicleId: raw.vehicleId } : {}),
      ...(raw.driverId !== undefined ? { driverId: raw.driverId } : {}),
      ...(raw.ownerId !== undefined ? { ownerId: raw.ownerId } : {}),
      ...(raw.routeNotes !== undefined ? { routeNotes: raw.routeNotes } : {}),
      ...(raw.routeId !== undefined ? { routeId: raw.routeId } : {}),
      ...(raw.driverRemark !== undefined ? { driverRemark: raw.driverRemark } : {}),
      ...(raw.vehicleRemark !== undefined ? { vehicleRemark: raw.vehicleRemark } : {}),
      ...(raw.plantsDetails ? { plantsDetails: raw.plantsDetails } : {}),
      ...(raw.afterDispatchedOrderIds !== undefined
        ? { afterDispatchedOrderIds: raw.afterDispatchedOrderIds }
        : {}),
    };

    const updated = await Dispatch.findByIdAndUpdate(
      dispatchOid,
      { $set: setPayload },
      { new: true, runValidators: true, session }
    );

    if (!updated) {
      throw new AppError("Failed to update dispatch", 500);
    }

    const expectedNurseryPatch =
      raw.expectedNursery != null && String(raw.expectedNursery).trim() !== ""
        ? String(raw.expectedNursery).trim()
        : "";
    const terminalStatuses = new Set([
      "COMPLETED",
      "PARTIALLY_COMPLETED",
      "CANCELLED",
      "REJECTED",
    ]);
    if (expectedNurseryPatch && effectiveNewIds.length) {
      for (const oidStr of effectiveNewIds) {
        const order = await Order.findById(oidStr).session(session);
        if (!order) continue;
        if (terminalStatuses.has(String(order.orderStatus || ""))) continue;
        await updateOrderWithLedgerSync({
          orderId: oidStr,
          existingDoc: order,
          session,
          userId: req.user?._id,
          req,
          contextLabel: "update_dispatch_expected_nursery",
          updateOperation: {
            $set: { expectedNursery: expectedNurseryPatch },
          },
        });
      }
    }

    await session.commitTransaction();
    fireQueuedDispatchedOrderAlerts(dispatchedAlertQueue);
    fireOrderEditWhatsAppAlerts(
      req._orderEditAlertQueue,
      req.user?.name || req.user?.email || "Unknown"
    );
    delete req._orderEditAlertQueue;

    const response = generateResponse(
      "Success",
      "Dispatch updated successfully",
      {
        ...updated.toObject(),
        deleted: false,
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

const calculateDispatchCrates = ({ dispatchQuantity, cavityId, cavityName, cavitySize, numberPerCrate }) => {
  const qty = Number(dispatchQuantity) || 0;
  const traySize = Number(cavitySize) || 0;
  const traysPerCrate = Number(numberPerCrate) || 0;

  if (qty <= 0 || traySize <= 0 || traysPerCrate <= 0) {
    return [];
  }

  const numberOfTrays = Math.floor(qty / traySize);
  const fullCrates = Math.floor(numberOfTrays / traysPerCrate);
  const plantsInFullCrates = fullCrates * traysPerCrate * traySize;
  const remainingPlants = Math.max(0, qty - plantsInFullCrates);

  const crateDetails = [];
  if (fullCrates > 0) {
    crateDetails.push({
      crateCount: fullCrates,
      plantCount: plantsInFullCrates,
    });
  }
  if (remainingPlants > 0) {
    crateDetails.push({
      crateCount: 1,
      plantCount: remainingPlants,
    });
  }
  if (!crateDetails.length) {
    return [];
  }

  return [
    {
      cavity: cavityId ? String(cavityId) : "",
      cavityName: cavityName || "",
      crateCount: crateDetails.reduce((sum, row) => sum + Number(row.crateCount || 0), 0),
      plantCount: crateDetails.reduce((sum, row) => sum + Number(row.plantCount || 0), 0),
      crateDetails,
    },
  ];
};

const buildPlantDispatchLabel = (plantCmsDoc, subtypeId) => {
  if (!plantCmsDoc || !plantCmsDoc.name) return "Plant";
  const st = plantCmsDoc.subtypes?.find(
    (s) => String(s?._id) === String(subtypeId)
  );
  const sub = st?.name?.trim();
  return sub ? `${plantCmsDoc.name} -> ${sub}` : plantCmsDoc.name;
};

const mergeCrateRow = (existingCrates, incoming) => {
  if (!incoming || !incoming.cavity) {
    existingCrates.push(incoming);
    return;
  }
  const idx = existingCrates.findIndex(
    (c) => String(c.cavity) === String(incoming.cavity)
  );
  if (idx < 0) {
    existingCrates.push({ ...incoming });
    return;
  }
  const cur = existingCrates[idx];
  cur.crateCount = Number(cur.crateCount || 0) + Number(incoming.crateCount || 0);
  cur.plantCount = Number(cur.plantCount || 0) + Number(incoming.plantCount || 0);
  cur.crateDetails = [
    ...(Array.isArray(cur.crateDetails) ? cur.crateDetails : []),
    ...(Array.isArray(incoming.crateDetails) ? incoming.crateDetails : []),
  ];
};

const mergePlantsDetailsForQuickAdd = (
  plantsDetails,
  {
    plantId,
    subTypeId,
    displayName,
    qty,
    tray,
    shadeId,
    shadeName,
    newCrates,
  }
) => {
  const list = JSON.parse(JSON.stringify(plantsDetails || []));
  const shadeOid = new mongoose.Types.ObjectId(String(shadeId));
  const pickupLine = {
    shade: shadeOid,
    shadeName: shadeName || "",
    quantity: Number(qty),
    cavity: new mongoose.Types.ObjectId(String(tray._id)),
    cavityName: tray.name || "",
  };

  const matchIdx = list.findIndex(
    (p) =>
      String(p.plantId) === String(plantId) &&
      String(p.subTypeId) === String(subTypeId)
  );

  const cratesToMerge = Array.isArray(newCrates) ? newCrates : [];

  if (matchIdx >= 0) {
    const p = list[matchIdx];
    p.pickupDetails = Array.isArray(p.pickupDetails) ? p.pickupDetails : [];
    p.pickupDetails.push(pickupLine);
    const pickupTotal = p.pickupDetails.reduce(
      (s, d) => s + Number(d.quantity || 0),
      0
    );
    p.quantity = pickupTotal;
    p.totalPlants = pickupTotal;
    p.crates = Array.isArray(p.crates) ? p.crates : [];
    cratesToMerge.forEach((nc) => mergeCrateRow(p.crates, nc));
  } else {
    list.push({
      name: displayName,
      id: String(plantId),
      plantId,
      subTypeId,
      quantity: Number(qty),
      totalPlants: Number(qty),
      pickupDetails: [pickupLine],
      crates: cratesToMerge.length ? [...cratesToMerge] : [],
      driverName: "",
      driverMobile: "",
      vehicleName: "",
    });
  }

  return list;
};

/**
 * When removing one order from a dispatch, reduce plantsDetails aggregates so PATCH payloads stay consistent.
 */
const prunePlantsDetailsForRemovedOrder = (plantsDetails, removalRow, orderLean) => {
  const list = JSON.parse(JSON.stringify(plantsDetails || []));
  if (!removalRow || !orderLean) return list;
  const qty = Math.max(0, Number(removalRow.dispatchQuantity || 0));
  if (qty <= 0) return list;
  const plantId = orderLean.plantName?._id || orderLean.plantName;
  const subTypeId = orderLean.plantSubtype;
  if (!plantId || !subTypeId) return list;
  const idx = list.findIndex(
    (p) => String(p.plantId) === String(plantId) && String(p.subTypeId) === String(subTypeId)
  );
  if (idx < 0) return list;
  const p = list[idx];
  const prevQ = Number(p.quantity || 0);
  const nextQ = Math.max(0, prevQ - qty);
  p.quantity = nextQ;
  p.totalPlants = nextQ;
  let left = qty;
  const pickups = Array.isArray(p.pickupDetails) ? p.pickupDetails : [];
  for (let i = pickups.length - 1; i >= 0 && left > 0; i--) {
    const cur = Number(pickups[i].quantity || 0);
    const take = Math.min(left, cur);
    pickups[i].quantity = cur - take;
    left -= take;
  }
  p.pickupDetails = pickups.filter((x) => Number(x.quantity) > 0);
  const remCrates = Array.isArray(removalRow.crates) ? removalRow.crates : [];
  if (remCrates.length && Array.isArray(p.crates)) {
    for (const rc of remCrates) {
      const cidx = p.crates.findIndex((c) => String(c.cavity) === String(rc.cavity));
      if (cidx < 0) continue;
      const c = p.crates[cidx];
      c.plantCount = Math.max(0, Number(c.plantCount || 0) - Number(rc.plantCount || 0));
      c.crateCount = Math.max(0, Number(c.crateCount || 0) - Number(rc.crateCount || 0));
    }
    p.crates = p.crates.filter((c) => Number(c.plantCount) > 0 || Number(c.crateCount) > 0);
  }
  if (nextQ <= 0 || !p.pickupDetails.length) {
    list.splice(idx, 1);
  }
  return list;
};

/** Remove one order from an in-flight dispatch (e.g. farmer refused); restores order to ready queue when appropriate. */
const detachOrderFromDispatch = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { orderId } = req.body || {};
  if (!orderId || !mongoose.isValidObjectId(String(orderId))) {
    return next(new AppError("orderId is required", 400));
  }
  const targetOrderStr = String(orderId);

  const session = await mongoose.startSession();
  session.startTransaction();
  req._orderEditAlertQueue = [];
  try {
    const existing = await findDispatchDocumentFlexible(id, session);
    if (!existing) {
      throw new AppError(DISPATCH_LOOKUP_NOT_FOUND, 404);
    }
    const dispatchOid = existing._id;
    const oldOrderIds = (existing.orderIds || []).map((x) => String(x));
    if (!oldOrderIds.includes(targetOrderStr)) {
      throw new AppError("Order is not on this dispatch", 400);
    }

    const oldDetailsByOrder = new Map();
    (existing.orderDispatchDetails || []).forEach((row) => {
      if (row?.orderId) {
        oldDetailsByOrder.set(String(row.orderId), Number(row.dispatchQuantity) || 0);
      }
    });

    const removalRow = (existing.orderDispatchDetails || []).find(
      (r) => r?.orderId && String(r.orderId) === targetOrderStr
    );

    const orderLean = await Order.findById(targetOrderStr)
      .populate({ path: "plantName", select: "name subtypes" })
      .session(session)
      .lean();
    if (!orderLean) {
      throw new AppError("Order not found", 404);
    }

    const newIdSet = new Set(oldOrderIds.filter((oid) => oid !== targetOrderStr));

    if (newIdSet.size === 0) {
      const revertIds = [...new Set([...oldOrderIds])];
      for (const oidStr of revertIds) {
        const ord = await Order.findById(oidStr).session(session);
        if (!ord) continue;
        const entry = (ord.dispatchHistory || []).find(
          (h) => h?.dispatchId && String(h.dispatchId) === String(dispatchOid)
        );
        if (entry) {
          const restored =
            orderRemainingOrBookable(ord) + (Number(entry.quantity) || 0);
          const nextStatus = orderStatusFromRemaining(ord, restored);
          const histAfter = (ord.dispatchHistory || []).filter(
            (h) => !h?.dispatchId || String(h.dispatchId) !== String(dispatchOid)
          );
          const nextCurrent =
            String(ord.currentDispatchId || "") === String(dispatchOid)
              ? computeCurrentDispatchIdAfterHistoryChange(histAfter, dispatchOid)
              : ord.currentDispatchId;
          await updateOrderWithLedgerSync({
            orderId: oidStr,
            existingDoc: ord,
            session,
            userId: req.user?._id,
          req,
            contextLabel: "detach_last_order_revert",
            updateOperation: {
              $set: {
                remainingPlants: restored,
                orderStatus: nextStatus,
                currentDispatchId: nextCurrent,
              },
              $pull: { dispatchHistory: { dispatchId: dispatchOid } },
            },
          });
        } else if (String(ord.currentDispatchId || "") === String(dispatchOid)) {
          await updateOrderWithLedgerSync({
            orderId: oidStr,
            existingDoc: ord,
            session,
            userId: req.user?._id,
          req,
            contextLabel: "detach_last_order_clear",
            updateOperation: {
              $set: {
                currentDispatchId: null,
                orderStatus: "READY_FOR_DISPATCH",
              },
            },
          });
        }
      }
      await Dispatch.deleteOne({ _id: dispatchOid }).session(session);
      await session.commitTransaction();
      fireOrderEditWhatsAppAlerts(
        req._orderEditAlertQueue,
        req.user?.name || req.user?.email || "Unknown"
      );
      delete req._orderEditAlertQueue;
      return res.status(200).json(
        generateResponse("Success", "Dispatch removed (no orders left)", {
          deleted: true,
          dispatchId: String(dispatchOid),
        })
      );
    }

    // Reuse removal loop for this single id (same as updateDispatch)
    for (const oldId of oldOrderIds) {
      if (newIdSet.has(oldId)) continue;
      if (oldId !== targetOrderStr) continue;
      const o = await Order.findById(oldId).session(session);
      if (!o) continue;
      const entry = (o.dispatchHistory || []).find(
        (h) => h?.dispatchId && String(h.dispatchId) === String(dispatchOid)
      );
      const fallbackQty = oldDetailsByOrder.get(oldId) || 0;
      const q = entry ? Number(entry.quantity) || 0 : fallbackQty;

      if (!entry && !q) {
        if (String(o.currentDispatchId || "") === String(dispatchOid)) {
          await updateOrderWithLedgerSync({
            orderId: oldId,
            existingDoc: o,
            session,
            userId: req.user?._id,
          req,
            contextLabel: "detach_order_no_hist",
            updateOperation: {
              $set: {
                currentDispatchId: null,
                orderStatus: "READY_FOR_DISPATCH",
              },
            },
          });
        }
        continue;
      }

      const restored = orderRemainingOrBookable(o) + q;
      const nextStatus = orderStatusFromRemaining(o, restored);
      const histAfter = (o.dispatchHistory || []).filter(
        (h) => !h?.dispatchId || String(h.dispatchId) !== String(dispatchOid)
      );
      const nextCurrent =
        String(o.currentDispatchId || "") === String(dispatchOid)
          ? computeCurrentDispatchIdAfterHistoryChange(histAfter, dispatchOid)
          : o.currentDispatchId;

      await updateOrderWithLedgerSync({
        orderId: oldId,
        existingDoc: o,
        session,
        userId: req.user?._id,
          req,
        contextLabel: "detach_order_from_dispatch",
        updateOperation: entry
          ? {
              $set: {
                remainingPlants: restored,
                orderStatus: nextStatus,
                currentDispatchId: nextCurrent,
              },
              $pull: { dispatchHistory: { dispatchId: dispatchOid } },
            }
          : {
              $set: {
                remainingPlants: restored,
                orderStatus: nextStatus,
                currentDispatchId: nextCurrent,
              },
            },
      });
    }

    const nextOrderDispatchDetails = (existing.orderDispatchDetails || []).filter(
      (d) => d?.orderId && String(d.orderId) !== targetOrderStr
    );

    const prunedPlants = prunePlantsDetailsForRemovedOrder(
      existing.plantsDetails,
      removalRow || {
        dispatchQuantity: oldDetailsByOrder.get(targetOrderStr) || 0,
        crates: [],
      },
      orderLean
    );
    const finalPlants =
      Array.isArray(prunedPlants) && prunedPlants.length > 0
        ? prunedPlants
        : existing.plantsDetails || [];

    const updated = await Dispatch.findByIdAndUpdate(
      dispatchOid,
      {
        $set: {
          orderIds: [...newIdSet].map((s) => new mongoose.Types.ObjectId(s)),
          orderDispatchDetails: nextOrderDispatchDetails,
          plantsDetails: finalPlants,
        },
      },
      { new: true, runValidators: true, session }
    );

    await session.commitTransaction();
    fireOrderEditWhatsAppAlerts(
      req._orderEditAlertQueue,
      req.user?.name || req.user?.email || "Unknown"
    );
    delete req._orderEditAlertQueue;
    return res.status(200).json(
      generateResponse("Success", "Order removed from dispatch", updated, undefined)
    );
  } catch (err) {
    await session.abortTransaction();
    return next(err);
  } finally {
    session.endSession();
  }
});

// Dedicated endpoint to add a post-dispatch (quick) order to an existing dispatch vehicle.
// Uses $push internally so it is safe behind express-mongo-sanitize.
const addOrderToDispatch = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const {
    orderId,
    dispatchQuantity,
    crates: cratesFromRequest = [],
    cavityId: cavityIdRaw,
    trayId: trayIdRaw,
    shadeId: shadeIdRaw,
    shadeName: shadeNameBody,
  } = req.body;

  if (!orderId) {
    return next(new AppError("orderId is required", 400));
  }

  const qty = Number(dispatchQuantity) || 0;
  if (qty <= 0) {
    return next(new AppError("dispatchQuantity must be greater than 0", 400));
  }

  const explicitCavityId = cavityIdRaw || trayIdRaw;
  if (!explicitCavityId || !mongoose.isValidObjectId(String(explicitCavityId))) {
    return next(new AppError("cavityId (tray _id) is required for quick add to dispatch", 400));
  }
  if (!shadeIdRaw || !mongoose.isValidObjectId(String(shadeIdRaw))) {
    return next(new AppError("shadeId is required for quick add to dispatch", 400));
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  const dispatchedAlertQueue = new Map();
  req._orderEditAlertQueue = [];

  try {
    const existingDispatchDoc = await findDispatchDocumentFlexible(id, session);
    if (!existingDispatchDoc) {
      throw new AppError(DISPATCH_LOOKUP_NOT_FOUND, 404);
    }
    const existingDispatch = existingDispatchDoc.toObject
      ? existingDispatchDoc.toObject()
      : existingDispatchDoc;
    const dispatchOid = existingDispatchDoc._id;

    const order = await Order.findById(orderId).session(session);
    const pendingLinkedAgriForOrder = await getPendingLinkedAgriLoads([orderId]);
    const pendingLinkedNurseryOrderIds = new Set(
      pendingLinkedAgriForOrder
        .map((o) => String(o?.linkedNurseryOrderId || "").trim())
        .filter(Boolean)
    );

    if (!order) {
      throw new AppError("Order not found", 404);
    }

    const orderPopulated = await Order.findById(orderId)
      .populate({ path: "plantName", select: "name subtypes" })
      .session(session);

    const currentRemaining = Number(order.remainingPlants ?? order.numberOfPlants ?? 0);
    if (qty > currentRemaining) {
      throw new AppError(
        `Dispatch quantity (${qty}) exceeds remaining plants (${currentRemaining}) for this order`,
        400
      );
    }

    const trayLean = await Tray.findById(explicitCavityId)
      .select("_id name cavity numberPerCrate")
      .session(session)
      .lean();
    if (!trayLean) {
      throw new AppError("Invalid cavity (tray) id", 400);
    }

    const shadeDoc = await Shade.findById(shadeIdRaw).session(session).lean();
    if (!shadeDoc) {
      throw new AppError("Invalid shade id", 400);
    }
    const shadeDisplayName = shadeDoc.name || shadeNameBody || "";

    const trayForOrder = {
      id: trayLean._id,
      name: trayLean.name || "",
      cavity: Number(trayLean.cavity || 0),
      numberPerCrate: Number(trayLean.numberPerCrate || 0),
    };

    const inferredCrates = calculateDispatchCrates({
      dispatchQuantity: qty,
      cavityId: trayForOrder.id || "",
      cavityName: trayForOrder.name || "",
      cavitySize: trayForOrder.cavity || 0,
      numberPerCrate: trayForOrder.numberPerCrate || 0,
    });

    const sanitizedCrates = Array.isArray(cratesFromRequest)
      ? cratesFromRequest.filter(
          (row) =>
            row &&
            (Number(row.plantCount) > 0 ||
              (Array.isArray(row.crateDetails) && row.crateDetails.length > 0))
        )
      : [];
    const fallbackCrates = [
      {
        cavity: String(trayLean._id),
        cavityName: trayLean.name || "N/A",
        crateCount: 0,
        plantCount: qty,
        crateDetails: [
          {
            crateCount: 0,
            plantCount: qty,
          },
        ],
      },
    ];
    const cratesForOrder =
      sanitizedCrates.length > 0
        ? sanitizedCrates
        : inferredCrates.length > 0
        ? inferredCrates
        : fallbackCrates;

    const plantId = orderPopulated?.plantName?._id || order.plantName;
    const subTypeId = order.plantSubtype;
    const displayName = buildPlantDispatchLabel(orderPopulated?.plantName, subTypeId);

    const mergedPlantsDetails = mergePlantsDetailsForQuickAdd(
      existingDispatch.plantsDetails,
      {
        plantId,
        subTypeId,
        displayName,
        qty,
        tray: trayLean,
        shadeId: shadeIdRaw,
        shadeName: shadeDisplayName,
        newCrates: cratesForOrder,
      }
    );

    const newRemainingPlants = Math.max(0, currentRemaining - qty);
    const newStatus =
      newRemainingPlants === 0
        ? "DISPATCHED"
        : newRemainingPlants < currentRemaining
        ? "DISPATCH_PROCESS"
        : order.orderStatus;

    const dispatch = await Dispatch.findByIdAndUpdate(
      dispatchOid,
      {
        $addToSet: {
          orderIds: orderId,
          afterDispatchedOrderIds: orderId,
        },
        $push: {
          orderDispatchDetails: {
            orderId,
            dispatchQuantity: qty,
            remainingAfterDispatch: newRemainingPlants,
            additionalPlants: 0,
            totalPlantsAfterAdjustments: qty,
            isPartialDispatch: newRemainingPlants > 0,
            driverName: existingDispatch.driverName || "",
            driverMobile: existingDispatch.driverMobile || "",
            vehicleName: existingDispatch.vehicleName || "",
            crates: cratesForOrder,
          },
        },
        $set: {
          plantsDetails: mergedPlantsDetails,
        },
      },
      { new: true, runValidators: false, session }
    );

    if (!dispatch) {
      throw new AppError(DISPATCH_LOOKUP_NOT_FOUND, 404);
    }

    const preAssignedQuick = String(order.deliveryChallanInvoiceNumber || "").trim();
    let official = null;
    let quickInvoiceLabel = preAssignedQuick;
    if (newStatus === "DISPATCHED" && newRemainingPlants === 0) {
      official = await ensureOfficialDeliveryChallanForOrder(order, session);
    }
    if (official) {
      quickInvoiceLabel = official;
    } else if (!quickInvoiceLabel) {
      const [freshQuick] = await allocateNextInvoiceNumbers(session, 1);
      quickInvoiceLabel = freshQuick || "";
    }

    const dispatchHistoryEntry = {
      date: new Date(),
      quantity: qty,
      dispatchId: dispatchOid,
      remainingAfterDispatch: newRemainingPlants,
      processedBy: req.user ? req.user._id : null,
      driverName: existingDispatch.driverName || "",
      vehicleName: existingDispatch.vehicleName || "",
      ...(quickInvoiceLabel ? { invoiceNumber: quickInvoiceLabel } : {}),
    };

    const quickAddSet = {
      remainingPlants: newRemainingPlants,
      orderStatus: newStatus,
      currentDispatchId: dispatchOid,
      cavity: trayLean._id,
    };
    if (official) {
      quickAddSet.officialDeliveryChallanNumber = official;
    }
    if (!preAssignedQuick && quickInvoiceLabel && !official) {
      quickAddSet.deliveryChallanInvoiceNumber = quickInvoiceLabel;
    }

    const updatedOrder = await updateOrderWithLedgerSync({
      orderId,
      existingDoc: order,
      updateOperation: {
        $set: quickAddSet,
        $push: {
          dispatchHistory: dispatchHistoryEntry,
        },
      },
            session,
            userId: req.user?._id,
            req,
            contextLabel: "quick_add_to_dispatch",
    });
    queueDispatchedOrderAlert({
      queue: dispatchedAlertQueue,
      previousOrder: order,
      updatedOrder,
      changedBy: req.user?.name || req.user?.email || "Unknown",
      allowedOrderIds: pendingLinkedNurseryOrderIds,
    });

    await session.commitTransaction();
    fireQueuedDispatchedOrderAlerts(dispatchedAlertQueue);
    fireOrderEditWhatsAppAlerts(
      req._orderEditAlertQueue,
      req.user?.name || req.user?.email || "Unknown"
    );
    delete req._orderEditAlertQueue;

    if (newStatus === "DISPATCHED") {
      (async () => {
        try {
          const { ensureFeedbackCallForOrder } = await import("../services/feedbackCallScheduling.js");
          const o = await Order.findById(orderId).lean();
          if (o) await ensureFeedbackCallForOrder(o, { isInstantDispatch: false });
        } catch (e) {
          console.error("voice-feedback addOrderToDispatch:", e?.message || e);
        }
      })();
    }

    const response = generateResponse(
      "Success",
      "Order added to dispatch successfully",
      dispatch
    );
    res.status(200).json(response);
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});

/** Non-deleted dispatches (field may be absent on older rows). */
const DISPATCH_NOT_DELETED = { isDeleted: { $ne: true } };

/** Match dispatches by vehicle/driver fields or by farmer/order on any linked order. */
async function resolveDispatchIdsForSearch(searchTrim) {
  const q = String(searchTrim || "").trim();
  if (!q) return [];

  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRx = new RegExp(esc, "i");
  const idSet = new Set();

  const transportRows = await Dispatch.find({
    ...DISPATCH_NOT_DELETED,
    $or: [
      { transportId: nameRx },
      { driverName: nameRx },
      { vehicleName: nameRx },
      { vehicleNumber: nameRx },
    ],
  })
    .select("_id")
    .lean();
  transportRows.forEach((d) => idSet.add(String(d._id)));

  const orderOr = [];
  const isNumeric = /^\d+$/.test(q);
  if (isNumeric) {
    const asNum = Number(q);
    if (Number.isSafeInteger(asNum)) {
      orderOr.push({ orderId: asNum });
    }
    if (q.length === 4) {
      orderOr.push({ publicOrderCode: q });
    }
  }

  orderOr.push({ "orderFor.name": nameRx });
  orderOr.push({ "orderFor.village": nameRx });
  orderOr.push({ "orderFor.talukaName": nameRx });
  orderOr.push({ "orderFor.districtName": nameRx });

  const mobileDigits = q.replace(/\D/g, "");
  if (mobileDigits.length >= 4) {
    orderOr.push({
      $expr: {
        $regexMatch: {
          input: {
            $toString: {
              $ifNull: ["$orderFor.mobileNumber", ""],
            },
          },
          regex: mobileDigits,
        },
      },
    });
  }

  const farmerOr = [{ name: nameRx }];
  if (mobileDigits.length >= 4) {
    farmerOr.push({
      $expr: {
        $regexMatch: {
          input: { $toString: { $ifNull: ["$mobileNumber", ""] } },
          regex: mobileDigits,
        },
      },
    });
  }
  const farmers = await Farmer.find({ $or: farmerOr }).select("_id").limit(200).lean();
  if (farmers.length) {
    orderOr.push({ farmer: { $in: farmers.map((f) => f._id) } });
  }

  if (orderOr.length) {
    const orders = await Order.find({ $or: orderOr })
      .select("_id currentDispatchId")
      .limit(500)
      .lean();
    const orderMongoIds = orders.map((o) => o._id);
    for (const o of orders) {
      if (o.currentDispatchId) idSet.add(String(o.currentDispatchId));
    }
    if (orderMongoIds.length) {
      const dispatchRows = await Dispatch.find({
        ...DISPATCH_NOT_DELETED,
        $or: [
          { orderIds: { $in: orderMongoIds } },
          { afterDispatchedOrderIds: { $in: orderMongoIds } },
        ],
      })
        .select("_id")
        .lean();
      dispatchRows.forEach((d) => idSet.add(String(d._id)));
    }
  }

  return [...idSet].map((id) => new mongoose.Types.ObjectId(id));
}

async function attachAgriLoadFlagsToDispatches(dispatches) {
  const allOrderIds = [];
  for (const d of dispatches) {
    for (const o of d.orderIds || []) {
      if (o?._id) allOrderIds.push(o._id);
    }
  }
  const pendingAgri = await getPendingLinkedAgriLoads(allOrderIds);
  const byNursery = new Map();
  for (const row of pendingAgri) {
    const nid = String(row.linkedNurseryOrderId || "");
    if (!nid) continue;
    if (!byNursery.has(nid)) byNursery.set(nid, []);
    byNursery.get(nid).push({
      agriOrderNumber: row.orderNumber,
      agriOrderId: row._id,
    });
  }
  return dispatches.map((d) => {
    const blockedBy = [];
    for (const o of d.orderIds || []) {
      const oid = String(o._id || "");
      blockedBy.push(...(byNursery.get(oid) || []));
    }
    return {
      ...d,
      agriLoadBlocked: blockedBy.length > 0,
      agriLoadBlockedBy: blockedBy,
    };
  });
}

// Get dispatches controller
const getDispatches = catchAsync(async (req, res, next) => {
  try {
    const hasPaging =
      req.query.page != null ||
      req.query.limit != null ||
      String(req.query.paged || "") === "1";

    const searchTrim = String(req.query.search || "").trim();
    const listFilter = { isDeleted: false };
    if (req.query.transportStatus) {
      listFilter.transportStatus = String(req.query.transportStatus);
    }
    if (searchTrim) {
      const searchIds = await resolveDispatchIdsForSearch(searchTrim);
      if (!searchIds.length) {
        const emptyPagination = hasPaging
          ? {
              total: 0,
              page: Math.max(1, parseInt(req.query.page, 10) || 1),
              limit: Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20)),
              pages: 1,
            }
          : undefined;
        return res
          .status(200)
          .json(
            generateResponse("Success", "Dispatches fetched successfully", [], undefined, {
              pagination: emptyPagination,
            })
          );
      }
      listFilter._id = { $in: searchIds };
    }

    let pagination = null;
    let idSortHint = null;
    let matchStage = { isDeleted: false };

    if (hasPaging) {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const total = await Dispatch.countDocuments(listFilter);
      const pages = Math.max(1, Math.ceil(total / limit) || 1);
      pagination = { total, page, limit, pages };
      const slice = await Dispatch.find(listFilter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select("_id")
        .lean();
      const ids = slice.map((d) => d._id);
      idSortHint = ids.map((x) => String(x));
      if (!ids.length) {
        return res
          .status(200)
          .json(
            generateResponse("Success", "Dispatches fetched successfully", [], undefined, {
              pagination,
            })
          );
      }
      matchStage = { isDeleted: false, _id: { $in: ids } };
    }

    // Perform the initial aggregation pipeline (optionally scoped to a page of dispatch ids)
    const dispatches = await Dispatch.aggregate([
      {
        $match: matchStage,
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
          damagedPlants: { $first: "$damagedPlants" },
          transportStatus: { $first: "$transportStatus" },
          deliveryChallanPdfUrl: { $first: "$deliveryChallanPdfUrl" },
          deliveryChallanPdfGeneratedAt: { $first: "$deliveryChallanPdfGeneratedAt" },
          completeInvoicePdfUrl: { $first: "$completeInvoicePdfUrl" },
          completeInvoicePdfGeneratedAt: { $first: "$completeInvoicePdfGeneratedAt" },
          createdAt: { $first: "$createdAt" }, // Keep as Date object
          updatedAt: { $first: "$updatedAt" }, // Keep as Date object
          orderIds: {
            $push: {
              _id: "$orderDetails._id",
              order: "$orderDetails.orderId",
              deliveryChallanInvoiceNumber: "$orderDetails.deliveryChallanInvoiceNumber",
              officialDeliveryChallanNumber:
                "$orderDetails.officialDeliveryChallanNumber",
              quantity: "$orderDetails.numberOfPlants",
              remainingPlants: "$orderDetails.remainingPlants",
              deliveryDate: "$orderDetails.deliveryDate", // Delivery date from order
              rate: "$orderDetails.rate",
              payment: "$orderDetails.payment",
              orderStatus: "$orderDetails.orderStatus",
              paymentCompleted: "$orderDetails.paymentCompleted",
              returnedPlants: "$orderDetails.returnedPlants",
              damagedPlants: "$orderDetails.damagedPlants",
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
                returnedPlants: "$orderDetails.returnedPlants",
                damagedPlants: "$orderDetails.damagedPlants",
                salesPerson: {
                  name: { $arrayElemAt: ["$salesPersonDetails.name", 0] },
                  phoneNumber: {
                    $arrayElemAt: ["$salesPersonDetails.phoneNumber", 0],
                  },
                },
                dispatchHistory: "$orderDetails.dispatchHistory",
                deliveryChallanInvoiceNumber:
                  "$orderDetails.deliveryChallanInvoiceNumber",
                officialDeliveryChallanNumber:
                  "$orderDetails.officialDeliveryChallanNumber",
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
        deliveryChallanPdfUrl: dispatch.deliveryChallanPdfUrl || "",
        completeInvoicePdfUrl: dispatch.completeInvoicePdfUrl || "",
        deliveryChallanPdfGeneratedAt: dispatch.deliveryChallanPdfGeneratedAt
          ? new Date(dispatch.deliveryChallanPdfGeneratedAt).toISOString()
          : null,
        completeInvoicePdfGeneratedAt: dispatch.completeInvoicePdfGeneratedAt
          ? new Date(dispatch.completeInvoicePdfGeneratedAt).toISOString()
          : null,
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

    let ordered = transformedDispatches;
    if (idSortHint?.length) {
      const rank = new Map(idSortHint.map((id, i) => [id, i]));
      ordered = [...transformedDispatches].sort(
        (a, b) => (rank.get(String(a._id)) ?? 0) - (rank.get(String(b._id)) ?? 0)
      );
    }

    ordered = await attachAgriLoadFlagsToDispatches(ordered);

    res.status(200).json(
      generateResponse(
        "Success",
        "Dispatches fetched successfully",
        ordered,
        undefined,
        pagination || undefined
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
    const resolved = await findDispatchDocumentFlexible(id);
    if (!resolved) {
      return next(new AppError(DISPATCH_LOOKUP_NOT_FOUND, 404));
    }
    const dispatch = await Dispatch.findById(resolved._id)
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
            select: "name variety type subtypes",
          },
          {
            path: "cavity",
            select: "name cavity numberPerCrate",
          },
          {
            path: "bookingSlot",
            select: "startDay endDay month",
          },
        ],
      })
      .lean(); // Using lean() for better performance

    if (!dispatch) {
      return next(new AppError(DISPATCH_LOOKUP_NOT_FOUND, 404));
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
      vehicleNumber: dispatch.vehicleNumber || "",
      isDeleted: dispatch.isDeleted || false,
      returnedPlants: dispatch.returnedPlants || 0,
      damagedPlants: dispatch.damagedPlants || 0,
      deliveryChallanPdfUrl: dispatch.deliveryChallanPdfUrl || "",
      deliveryChallanPdfGeneratedAt: dispatch.deliveryChallanPdfGeneratedAt || null,
      completeInvoicePdfUrl: dispatch.completeInvoicePdfUrl || "",
      completeInvoicePdfGeneratedAt: dispatch.completeInvoicePdfGeneratedAt || null,
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
        deliveryChallanInvoiceNumber: order.deliveryChallanInvoiceNumber || "",
        officialDeliveryChallanNumber: order.officialDeliveryChallanNumber || "",
        farmer: order.farmer,
        salesPerson: order.salesPerson,
        plantName: order.plantName,
        plantSubtype: order.plantSubtype,
        cavity: order.cavity,
        bookingSlot: order.bookingSlot,
        numberOfPlants: order.numberOfPlants,
        remainingPlants: orderRemainingOrBookable(order),
        rate: order.rate,
        payment: order.payment,
        orderStatus: order.orderStatus,
        returnedPlants: order.returnedPlants,
        damagedPlants: order.damagedPlants,
        returnReason: order.returnReason,
        quotaSource: order.quotaSource,
        additionalPlants: order.additionalPlants,
        dealerOrder: order.dealerOrder,
        orderBookingDate: order.orderBookingDate,
        deliveryDate: order.deliveryDate,
        notes: order.notes,
        dispatchHistory: order.dispatchHistory || [],
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

/** Lean dispatch + tray map for server-side PDFs (same populate as getDispatch). */
async function loadDispatchLeanForPdfGeneration(dispatchObjectId) {
  const dispatch = await Dispatch.findById(dispatchObjectId)
    .populate({ path: "tripId" })
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
          select: "name variety type subtypes",
        },
        {
          path: "cavity",
          select: "name cavity numberPerCrate",
        },
        {
          path: "bookingSlot",
          select: "startDay endDay month",
        },
      ],
    })
    .lean();

  if (!dispatch) return null;

  const trayIds = [];
  (dispatch.plantsDetails || []).forEach((plant) => {
    if (Array.isArray(plant.pickupDetails)) {
      plant.pickupDetails.forEach((pickup) => {
        if (pickup.cavity) trayIds.push(pickup.cavity);
      });
    }
    if (Array.isArray(plant.crates)) {
      plant.crates.forEach((crate) => {
        if (crate.cavity) trayIds.push(crate.cavity);
      });
    }
  });
  const uniqueTrayIds = [...new Set(trayIds.map((id) => id.toString()))];
  const trays = await Tray.find({ _id: { $in: uniqueTrayIds } }).lean();
  const trayMap = trays.reduce((map, tray) => {
    map[tray._id.toString()] = tray;
    return map;
  }, {});
  return { dispatch, trayMap };
}

const regenerateDispatchPdfs = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const perm = getOrderUpdateUserContext(
    resolveUserForOrderUpdatePermissions(req) || req.user
  );
  if (!perm.canEditOrderCore) {
    return next(new AppError("You are not allowed to generate dispatch PDFs", 403));
  }

  const resolved = await findDispatchDocumentFlexible(id);
  if (!resolved) {
    return next(new AppError(DISPATCH_LOOKUP_NOT_FOUND, 404));
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const allowedTypes = new Set(["delivery_challan", "complete_invoice"]);
  let types = ["delivery_challan", "complete_invoice"];
  if (Array.isArray(body.types) && body.types.length > 0) {
    types = body.types
      .map((t) => String(t).trim().toLowerCase())
      .filter((t) => allowedTypes.has(t));
  }
  if (!types.length) {
    types = ["delivery_challan", "complete_invoice"];
  }

  const loaded = await loadDispatchLeanForPdfGeneration(resolved._id);
  if (!loaded) {
    return next(new AppError(DISPATCH_LOOKUP_NOT_FOUND, 404));
  }

  const { dispatch } = loaded;

  if (types.includes("complete_invoice") && dispatch.transportStatus !== "DELIVERED") {
    return next(
      new AppError(
        "Complete invoice PDF is only available when transport status is DELIVERED",
        400
      )
    );
  }

  const dispatchObjectId = String(dispatch._id);
  const now = new Date();
  const $set = {};

  if (types.includes("delivery_challan")) {
    const buf = await buildDeliveryChallanPdfBuffer(dispatch);
    const url = await uploadToS3(buf, `delivery-challan-${dispatchObjectId}.pdf`, {
      folder: `dispatch-pdfs/${dispatchObjectId}`,
    });
    $set.deliveryChallanPdfUrl = url;
    $set.deliveryChallanPdfGeneratedAt = now;
  }

  if (types.includes("complete_invoice")) {
    const buf = await buildCompleteInvoicePdfBuffer(dispatch);
    const url = await uploadToS3(buf, `complete-invoice-${dispatchObjectId}.pdf`, {
      folder: `dispatch-pdfs/${dispatchObjectId}`,
    });
    $set.completeInvoicePdfUrl = url;
    $set.completeInvoicePdfGeneratedAt = now;
  }

  const updated = await Dispatch.findByIdAndUpdate(dispatch._id, { $set }, { new: true })
    .select(
      "deliveryChallanPdfUrl deliveryChallanPdfGeneratedAt completeInvoicePdfUrl completeInvoicePdfGeneratedAt"
    )
    .lean();

  if (!updated) {
    return next(new AppError(DISPATCH_LOOKUP_NOT_FOUND, 404));
  }

  res.status(200).json(
    generateResponse("Success", "Dispatch PDFs generated", {
      deliveryChallanPdfUrl: updated.deliveryChallanPdfUrl || "",
      deliveryChallanPdfGeneratedAt: updated.deliveryChallanPdfGeneratedAt || null,
      completeInvoicePdfUrl: updated.completeInvoicePdfUrl || "",
      completeInvoicePdfGeneratedAt: updated.completeInvoicePdfGeneratedAt || null,
    })
  );
});

const removeTransport = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  req._orderEditAlertQueue = [];

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

    // Update orders to restore quantities (ledger-safe)
    if (dispatch.orderDispatchDetails && dispatch.orderDispatchDetails.length > 0) {
      for (const orderDispatch of dispatch.orderDispatchDetails) {
        const order = await Order.findById(orderDispatch.orderId).session(session);

        if (!order) {
          console.log(`Order not found: ${orderDispatch.orderId}`);
          continue;
        }

        const dispatchHistoryEntry = order.dispatchHistory?.find(
          (entry) =>
            entry?.dispatchId &&
            String(entry.dispatchId) === String(dispatch._id)
        );

        if (dispatchHistoryEntry) {
          const restoredRemainingPlants =
            orderRemainingOrBookable(order) +
            (Number(dispatchHistoryEntry.quantity) || 0);
          const nextHist = (order.dispatchHistory || []).filter(
            (h) =>
              !(
                h?.dispatchId &&
                String(h.dispatchId) === String(dispatch._id)
              )
          );
          const nextCurrent =
            String(order.currentDispatchId || "") === String(dispatch._id)
              ? computeCurrentDispatchIdAfterHistoryChange(nextHist, dispatch._id)
              : order.currentDispatchId;
          const newStatus = orderStatusFromRemaining(
            order,
            restoredRemainingPlants
          );

          await updateOrderWithLedgerSync({
            orderId: orderDispatch.orderId,
            existingDoc: order,
            session,
            userId: req.user?._id,
          req,
            contextLabel: "remove_transport_restore",
            updateOperation: {
              $set: {
                remainingPlants: restoredRemainingPlants,
                orderStatus: newStatus,
                currentDispatchId: nextCurrent,
              },
              $pull: {
                dispatchHistory: { dispatchId: dispatch._id },
              },
            },
          });

          ordersUpdated.push({
            orderId: order.orderId,
            restoredQuantity: dispatchHistoryEntry.quantity,
            newRemainingPlants: restoredRemainingPlants,
          });
        } else if (String(order.currentDispatchId || "") === String(dispatch._id)) {
          await updateOrderWithLedgerSync({
            orderId: orderDispatch.orderId,
            existingDoc: order,
            session,
            userId: req.user?._id,
          req,
            contextLabel: "remove_transport_no_history",
            updateOperation: {
              $set: {
                currentDispatchId: null,
                orderStatus: "READY_FOR_DISPATCH",
              },
            },
          });
        }
      }
    } else {
      const ids = dispatch.orderIds || [];
      for (const oid of ids) {
        const o = await Order.findById(oid).session(session);
        if (!o) continue;
        const patch =
          String(o.currentDispatchId || "") === String(dispatch._id)
            ? {
                currentDispatchId: null,
                orderStatus: "READY_FOR_DISPATCH",
              }
            : { orderStatus: "READY_FOR_DISPATCH" };
        await updateOrderWithLedgerSync({
          orderId: oid,
          existingDoc: o,
          session,
          userId: req.user?._id,
          req,
          contextLabel: "remove_transport_legacy_bulk",
          updateOperation: { $set: patch },
        });
      }
    }

    const affectedOrderIds = Array.from(
      new Set(
        (dispatch.orderDispatchDetails && dispatch.orderDispatchDetails.length > 0
          ? dispatch.orderDispatchDetails.map((od) => String(od?.orderId || "").trim())
          : (dispatch.orderIds || []).map((oid) => String(oid || "").trim())
        ).filter(Boolean)
      )
    )
      .filter((id) => mongoose.isValidObjectId(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (affectedOrderIds.length > 0) {
      const linkedAgriRows = await AgriSalesOrder.find({
        linkedNurseryOrderId: { $in: affectedOrderIds },
        agriLoadStatus: "LOADED",
        orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
      }).session(session);

      for (const row of linkedAgriRows) {
        row.agriLoadStatus = "PENDING_LOAD";
        row.loadedAt = null;
        row.loadedBy = null;
        if (!Array.isArray(row.activityLog)) row.activityLog = [];
        row.activityLog.push({
          action: "DISPATCH_UPDATED",
          description: `Reset to PENDING_LOAD because dispatch ${dispatch.transportId} was removed.`,
          performedBy: req.user?._id || req.user?.id || null,
          performedByName: req.user?.name || "System",
          metadata: {
            agriLoadStatus: "PENDING_LOAD",
            source: "DISPATCH_DELETE_ROLLBACK",
            dispatchId: dispatch._id,
            transportId: dispatch.transportId,
          },
        });
        await row.save({ session });
      }
    }

    // Delete the dispatch document
    await Dispatch.deleteOne({ _id: dispatch._id }, { session });

    await session.commitTransaction();
    fireOrderEditWhatsAppAlerts(
      req._orderEditAlertQueue,
      req.user?.name || req.user?.email || "Unknown"
    );
    delete req._orderEditAlertQueue;

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
  const { orderUpdates, expectedNursery: bodyExpectedNursery, tripData } = req.body || {};

  const session = await mongoose.startSession();
  session.startTransaction();
  req._orderEditAlertQueue = [];

  try {
    const dispatch = await findDispatchDocumentFlexible(id, session);

    if (!dispatch) {
      return next(new AppError(DISPATCH_LOOKUP_NOT_FOUND, 404));
    }
    const dispatchOid = dispatch._id;

    // Calculate total returned and damaged plants for this completion submit.
    const totalReturnedPlants =
      orderUpdates?.reduce(
        (sum, order) => sum + (Number(order.returnedPlants) || 0),
        0
      ) || 0;
    const totalDamagedPlants =
      orderUpdates?.reduce(
        (sum, order) => sum + (Number(order.damagedPlants) || 0),
        0
      ) || 0;

    // Update dispatch with returned plants and transport status
    const updatedDispatch = await Dispatch.findByIdAndUpdate(
      dispatchOid,
      {
        returnedPlants: totalReturnedPlants,
        damagedPlants: totalDamagedPlants,
        transportStatus: "DELIVERED", // Update transport status to DELIVERED
      },
      { new: true, runValidators: true, session }
    );

    // Upsert Trip document with vehicle trip details if provided
    if (
      tripData &&
      (tripData.kmRun != null || tripData.rent != null || tripData.otherCharges != null || tripData.remark)
    ) {
      const tripSet = {
        vehicleId: dispatch.vehicleId || undefined,
        vehicleName: dispatch.vehicleName || "",
        vehicleNumber: dispatch.vehicleNumber || "",
        driverName: dispatch.driverName || "",
        driverContact: dispatch.driverMobile || "",
        dispatchId: dispatchOid,
        orderIds: dispatch.orderIds,
        status: "delivered",
        endDate: new Date(),
      };
      if (tripData.kmRun != null && tripData.kmRun !== "") tripSet.kmRun = Number(tripData.kmRun);
      if (tripData.rent != null && tripData.rent !== "") tripSet.rent = Number(tripData.rent);
      if (tripData.otherCharges != null && tripData.otherCharges !== "") tripSet.otherCharges = Number(tripData.otherCharges);
      if (tripData.remark) tripSet.tripRemark = String(tripData.remark);
      const trip = await Trip.findOneAndUpdate(
        { dispatchId: dispatchOid },
        { $set: tripSet },
        { new: true, upsert: true, session, setDefaultsOnInsert: true }
      );
      await Dispatch.findByIdAndUpdate(dispatchOid, { tripId: trip._id }, { session });
    }

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
        .populate("farmer", "name village")
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
      const damagedForThisOrder = Math.max(
        0,
        Number.isNaN(Number(orderUpdate.damagedPlants))
          ? 0
          : Number(orderUpdate.damagedPlants)
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
      const existingDamagedPlants = order.damagedPlants || 0;
      const totalDamagedPlants = existingDamagedPlants + damagedForThisOrder;

      if (totalReturnedPlants + totalDamagedPlants > totalOrderedPlants) {
        const orderDisplayId = order.orderId || order._id?.toString();
        throw new AppError(
          `Returned + damaged plants cannot exceed the total plants for Order #${orderDisplayId}`,
          400
        );
      }

      // Prepare update object for the order - initially empty
      const orderUpdateData = {};
      // findByIdAndUpdate does not run mongoose save hooks — keep gross booked count on the order in sync
      orderUpdateData.totalPlants = totalOrderedPlants;

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
      const finalStatusFromActions = orderUpdate.actions?.finalStatus;
      const nurseryRemaining = orderRemainingOrBookable(order);

      // Prefer explicit finalStatus from UI (e.g. READY_FOR_DISPATCH when remainingPlants > 0)
      let orderStatusToSet = null;
      if (finalStatusFromActions) {
        orderStatusToSet = finalStatusFromActions;
      } else if (completeOrder) {
        orderStatusToSet = "COMPLETED";
      } else if (returnsForThisOrder > 0) {
        orderStatusToSet = "PARTIALLY_COMPLETED";
      }

      // Stale UI (remainingPlants shown as bookable total when DB has 0) must not revert to queue.
      if (
        nurseryRemaining === 0 &&
        returnsForThisOrder === 0 &&
        (completeOrder || orderStatusToSet === "READY_FOR_DISPATCH")
      ) {
        orderStatusToSet = "COMPLETED";
      }

      if (orderStatusToSet) {
        orderUpdateData.orderStatus = orderStatusToSet;
      }

      let returnHistoryEntry = null;
      // Only update return-related fields if there are actual returns
      if (returnsForThisOrder > 0) {
        orderUpdateData.returnedPlants = totalReturnedPlants;

        if (orderUpdate.returnReason) {
          orderUpdateData.returnReason = orderUpdate.returnReason;
        }

        // Return history tracks only the quantity that came back to stock.
        returnHistoryEntry = {
          date: new Date(),
          quantity: returnsForThisOrder,
          reason: orderUpdate.returnReason || "Return from dispatch",
          dispatchId: dispatch._id,
          processedBy: req.user ? req.user._id : undefined,
        };
      }

      if (damagedForThisOrder > 0) {
        orderUpdateData.damagedPlants = totalDamagedPlants;
      }

      // remainingPlants = undispatched at nursery; returns do not increase it.
      if (hasAdditionalUpdate) {
        const prevRem = Number(order.remainingPlants) || 0;
        const prevAdd = order.additionalPlants || 0;
        const deltaAdd = additionalPlantsValue - prevAdd;
        orderUpdateData.remainingPlants = Math.max(0, prevRem + deltaAdd);
      }

      let freightForTotal = Math.max(0, Number(order.freightCharges) || 0);
      if (orderUpdate.freightCharges !== undefined && orderUpdate.freightCharges !== null) {
        freightForTotal = Math.max(0, Number(orderUpdate.freightCharges) || 0);
        if (freightForTotal !== (order.freightCharges || 0)) {
          orderUpdateData.freightCharges = freightForTotal;
        }
      }

      const newPaymentSubdocs = buildDispatchCompletePaymentSubdocs(
        orderUpdate.newPayments,
        req.user,
        order
      );

      const collectedAmount = roundMoney(
        (order.payment || []).reduce((sum, payment) => {
          if (payment?.paymentStatus === "COLLECTED") {
            return sum + (payment.paidAmount || 0);
          }
          return sum;
        }, 0) + sumCollectedFromNewPaymentSubdocs(newPaymentSubdocs)
      );

      const recalculatedTotalAmount = roundMoney(
        (order.rate || 0) * totalOrderedPlants + freightForTotal
      );
      const isPaymentComplete = collectedAmount >= recalculatedTotalAmount;

      orderUpdateData.orderPaymentStatus = isPaymentComplete
        ? "COMPLETED"
        : "PENDING";
      orderUpdateData.paymentCompleted = isPaymentComplete;

      const globalNursery =
        bodyExpectedNursery != null && String(bodyExpectedNursery).trim() !== ""
          ? String(bodyExpectedNursery).trim()
          : null;
      const perOrderNursery =
        orderUpdate?.expectedNursery != null &&
        String(orderUpdate.expectedNursery).trim() !== ""
          ? String(orderUpdate.expectedNursery).trim()
          : null;
      const nurseryToSet = perOrderNursery || globalNursery;
      if (nurseryToSet) {
        orderUpdateData.expectedNursery = nurseryToSet;
      }

      if (orderUpdate.batchNumber !== undefined) {
        orderUpdateData.batchNumber = String(orderUpdate.batchNumber ?? "").trim();
      }

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

      // Returns always go back to quota/slot inventory. Damaged qty is recorded separately.
      if (returnsForThisOrder > 0) {
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
      const pushPayload = {};
      if (returnHistoryEntry) {
        pushPayload.returnHistory = returnHistoryEntry;
      }
      if (
        orderUpdateData.freightCharges !== undefined &&
        orderUpdateData.freightCharges !== (order.freightCharges || 0)
      ) {
        pushPayload.orderEditHistory = {
          field: "freightCharges",
          previousValue: order.freightCharges || 0,
          newValue: orderUpdateData.freightCharges,
          changedBy: req.user ? req.user._id : undefined,
          notes: `Freight charges set to ₹${orderUpdateData.freightCharges}`,
        };
      }
      if (newPaymentSubdocs.length > 0) {
        pushPayload.payment = { $each: newPaymentSubdocs };
      }
      if (Object.keys(pushPayload).length > 0) {
        updateOperation.$push = pushPayload;
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
          req,
        contextLabel: "complete_dispatch_order_update",
        ledgerSyncOptions: { orderEditSource: "dispatch_complete" },
      });

      if (newPaymentSubdocs.length > 0) {
        const farmerInfo = formatOrderWalletDescriptionContext(order);
        await applyWalletForDispatchNewPayments(
          updatedOrder,
          newPaymentSubdocs,
          farmerInfo,
          req.user?._id,
          session
        );
      }

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
    fireOrderEditWhatsAppAlerts(
      req._orderEditAlertQueue,
      req.user?.name || req.user?.email || "Unknown"
    );
    delete req._orderEditAlertQueue;

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
const buildReadyDispatchGroupCode = () =>
  `RDG-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;

const getOrderPlantCountForGroup = (order) =>
  Number(order?.totalPlants || order?.numberOfPlants || 0);

const assignRoute = catchAsync(async (req, res, next) => {
  const {
    orderIds,
    vehicleId,
    driverId,
    driverName: bodyDriverName,
    driverMobile: bodyDriverMobile,
    vehicleName: bodyVehicleName,
    vehicleNumber: bodyVehicleNumber,
    routeId,
    routeNotes,
    driverRemark: bodyDriverRemark,
    vehicleRemark: bodyVehicleRemark,
    groupName,
    markReady = false,
  } = req.body;

  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return next(new AppError("orderIds array is required", 400));
  }

  let resolvedDriverName = bodyDriverName || "";
  let resolvedDriverMobile = bodyDriverMobile || "";
  let resolvedVehicleName = bodyVehicleName || "";
  let resolvedVehicleNumber = bodyVehicleNumber || "";
  let resolvedVehicleId = null;
  let resolvedDriverId = null;
  let resolvedOwnerId = null;

  if (vehicleId && mongoose.isValidObjectId(String(vehicleId))) {
    const vehicle = await Vehicle.findById(vehicleId).lean();
    if (vehicle) {
      resolvedVehicleId = vehicle._id;
      resolvedVehicleName = resolvedVehicleName || vehicle.name || "";
      resolvedVehicleNumber = resolvedVehicleNumber || vehicle.number || "";
      if (vehicle.ownerId) resolvedOwnerId = vehicle.ownerId;
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
      if (!resolvedOwnerId && driver.ownerId) resolvedOwnerId = driver.ownerId;
    }
  }

  const driverRemark = String(bodyDriverRemark ?? "").trim();
  const vehicleRemark = String(bodyVehicleRemark ?? "").trim();
  const routeNotesStr = String(routeNotes ?? "").trim();
  const routeIdStr = routeId != null ? String(routeId).trim() : "";
  const groupNotes = String(groupName ?? "").trim();

  const assignedAt = new Date();
  const assignedBy = req.user?._id || null;

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

    let readyDispatchGroup = null;
    const canMergeGroup = resolvedVehicleId || routeIdStr;
    if (canMergeGroup) {
      const mergeFilter = { status: "DRAFT" };
      if (resolvedVehicleId) mergeFilter.vehicleId = resolvedVehicleId;
      if (routeIdStr) mergeFilter.routeId = routeIdStr;
      readyDispatchGroup = await ReadyDispatchGroup.findOne(mergeFilter).session(
        session
      );
    }

    const mergedIdSet = new Set(
      (readyDispatchGroup?.orderIds || []).map((id) => String(id))
    );
    validIds.forEach((id) => mergedIdSet.add(String(id)));
    const mergedOrderIds = [...mergedIdSet].map(
      (id) => new mongoose.Types.ObjectId(id)
    );

    const allOrdersForTotal = await Order.find({
      _id: { $in: mergedOrderIds },
    })
      .select("totalPlants numberOfPlants")
      .session(session)
      .lean();
    const totalPlants = allOrdersForTotal.reduce(
      (sum, o) => sum + getOrderPlantCountForGroup(o),
      0
    );

    const groupFleetSet = {
      ownerId: resolvedOwnerId || null,
      vehicleId: resolvedVehicleId || null,
      driverId: resolvedDriverId || null,
      vehicleNumber: resolvedVehicleNumber || "",
      vehicleName: resolvedVehicleName || "",
      driverName: resolvedDriverName || "",
      driverMobile: resolvedDriverMobile || "",
      vehicleRef: resolvedVehicleNumber || resolvedVehicleName || "",
      routeId: routeIdStr,
      routeNotes: routeNotesStr,
      driverRemark,
      vehicleRemark,
      orderIds: mergedOrderIds,
      totalPlants,
      ...(groupNotes ? { notes: groupNotes } : {}),
      ...(assignedBy ? { createdBy: assignedBy } : {}),
    };

    if (readyDispatchGroup) {
      Object.assign(readyDispatchGroup, groupFleetSet);
      await readyDispatchGroup.save({ session });
    } else {
      [readyDispatchGroup] = await ReadyDispatchGroup.create(
        [
          {
            groupCode: buildReadyDispatchGroupCode(),
            status: "DRAFT",
            ...groupFleetSet,
          },
        ],
        { session }
      );
    }

    const orderSet = {
      assignedVehicle: resolvedVehicleNumber || resolvedVehicleName,
      assignedAt,
      readyDispatchGroupId: readyDispatchGroup._id,
      driverRemark,
      vehicleRemark,
      ...(routeIdStr ? { routeId: routeIdStr } : {}),
      ...(assignedBy ? { assignedBy } : {}),
    };

    await Order.updateMany(
      { _id: { $in: validIds } },
      { $set: orderSet },
      { session }
    );

    let readyCount = 0;
    if (markReady) {
      const farmReadyOrders = await Order.find(
        { _id: { $in: validIds }, orderStatus: "FARM_READY" },
        "_id orderStatus"
      )
        .session(session)
        .lean();

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
        ownerId: resolvedOwnerId,
        routeId: routeIdStr || null,
        routeNotes: routeNotesStr,
        driverRemark,
        vehicleRemark,
        readyDispatchGroupId: readyDispatchGroup._id,
        groupCode: readyDispatchGroup.groupCode,
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

  const { getDispatchTargetDateFromKey } = await import("../utility/dispatchDay.js");
  const { applyEarlyDispatch } = await import("../services/earlyDispatch.service.js");
  const dispatchDayKey = "TODAY";
  const dispatchTargetDate = getDispatchTargetDateFromKey(dispatchDayKey);

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const eligibleOrders = await Order.find({
      _id: { $in: validIds },
      orderStatus: { $in: ["FARM_READY", "PROCESSING", "ACCEPTED"] },
    })
      .session(session);

    let updatedCount = 0;
    for (const ord of eligibleOrders) {
      const filteredBody = {
        orderStatus: "READY_FOR_DISPATCH",
        dispatchDayKey,
        dispatchTargetDate,
      };

      if (dispatchTargetDate) {
        await applyEarlyDispatch({
          order: ord,
          dispatchTargetDate,
          session,
          filteredBody,
          userId: req.user?._id,
        });
      }

      const { __earlyDispatchSlotHandled, ...setFields } = filteredBody;

      await Order.findByIdAndUpdate(
        ord._id,
        appendStatusChangeToUpdate(
          { $set: setFields },
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
  regenerateDispatchPdfs,
  removeTransport,
  assignRoute,
  bulkMarkReady,
  detachOrderFromDispatch,
  updateOrderWithLedgerSync,
};
