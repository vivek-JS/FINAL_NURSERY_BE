import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import Dispatch from "../models/dispatch.model.js";
import Order from "../models/order.model.js";
import Farmer from "../models/farmer.model.js";
import PlantSlot from "../models/slots.model.js";
import { allocateNextOrderId } from "../services/orderIdAllocation.service.js";
import { updateOrderWithLedgerSync } from "./dispatch.controller.js";
import {
  ensureFarmerPlantOrderDebit,
  recordFarmerPlantLedgerPaymentTransition,
  roundMoney,
} from "../utils/farmerPlantOrderLedgerHelper.js";
import {
  buildDispatchCompletePaymentSubdocs,
  applyWalletForDispatchNewPayments,
  sumCollectedFromNewPaymentSubdocs,
  formatOrderWalletDescriptionContext,
} from "../utils/dispatchCompleteOrderPayments.js";

const REASSIGN_MODES = new Set(["ALL", "SOME", "RETURNED"]);
const TEMP_CANCELLED = "TEMPORARY_CANCELLED";

/** Plants physically loaded on the vehicle for one order (total booked minus what stayed at nursery). */
const onVehicleQty = (order) => {
  const total =
    Number(order?.numberOfPlants || 0) + Number(order?.additionalPlants || 0);
  const remaining = Number(order?.remainingPlants);
  const dispatched = Number.isFinite(remaining)
    ? Math.max(0, total - remaining)
    : total;
  return Math.max(0, dispatched);
};

/** Release `qty` plants back to the nursery slot (regular orders give availablePlants back). */
const releaseSlotQuantity = async (order, qty, session) => {
  if (!(qty > 0) || !order?.bookingSlot) return;
  const slotDoc = await PlantSlot.findOne(
    { "subtypeSlots.slots._id": order.bookingSlot },
    { "subtypeSlots.$": 1 }
  )
    .populate("plantId", "sowingAllowed")
    .session(session);

  const isSowingAllowed = slotDoc?.plantId?.sowingAllowed || false;
  const isReadyPlantsOrder = !!(order.productMappingId && order.productName);

  const slotInc = {
    "subtypeSlots.$[subtypeSlot].slots.$[slot].totalBookedPlants": -qty,
  };
  if (isReadyPlantsOrder) {
    slotInc["subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants"] = -qty;
  } else if (!isSowingAllowed) {
    slotInc["subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants"] = qty;
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
};

/** find-or-create farmer by mobile; falls back to a fresh farmer when no mobile is supplied. */
const resolveReassignFarmer = async (row, session) => {
  const mobileDigits =
    row.mobileNumber != null && String(row.mobileNumber).trim() !== ""
      ? String(row.mobileNumber).replace(/\D/g, "")
      : "";
  const mobileNumber =
    mobileDigits.length >= 10 ? Number(mobileDigits.slice(-10)) : undefined;

  const farmerPayload = {
    name: String(row.name || "").trim(),
    village: row.village || row.villageName || "",
    taluka: row.taluka || row.talukaName || "",
    district: row.district || row.districtName || "",
    state: row.state || row.stateName || "",
    stateName: row.stateName || row.state || "",
    talukaName: row.talukaName || row.taluka || "",
    districtName: row.districtName || row.district || "",
    ...(mobileNumber != null ? { mobileNumber } : {}),
  };

  if (mobileNumber != null) {
    const existing = await Farmer.findOne({ mobileNumber }).session(session);
    if (existing) return existing;
  }

  const [created] = await Farmer.create([farmerPayload], { session });
  return created;
};

/**
 * PATCH /dispatched/:id/reassign-refused
 *
 * Handles "vehicle dispatched but the farmer refused, plants handed to other farmers".
 * - Original (refused) orders are temporarily cancelled or kept, with full ledger + history.
 * - Plants that came back to the nursery release the booking slot (returnedQty).
 * - Plants handed to other farmers become NEW "field" orders that DO NOT touch slots,
 *   while still writing the ORDER debit, optional payment, and order history.
 */
export const reassignRefusedDelivery = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { mode, originalOrders = [], newFarmers = [] } = req.body || {};

  const normalizedMode = String(mode || "").toUpperCase();
  if (!REASSIGN_MODES.has(normalizedMode)) {
    return next(
      new AppError("mode must be one of ALL, SOME, RETURNED", 400)
    );
  }
  if (!Array.isArray(originalOrders) || originalOrders.length === 0) {
    return next(new AppError("originalOrders is required", 400));
  }
  if (normalizedMode !== "RETURNED" && (!Array.isArray(newFarmers) || newFarmers.length === 0)) {
    return next(
      new AppError("At least one receiving farmer is required for this mode", 400)
    );
  }

  const userId = req.user?._id || req.user?.id || null;
  const session = await mongoose.startSession();
  session.startTransaction();
  req._orderEditAlertQueue = req._orderEditAlertQueue || [];

  try {
    const dispatch = mongoose.Types.ObjectId.isValid(String(id))
      ? await Dispatch.findById(id).session(session)
      : await Dispatch.findOne({ transportId: id }).session(session);
    if (!dispatch) {
      await session.abortTransaction();
      return next(new AppError("Dispatch not found", 404));
    }

    // Load original orders referenced in the request.
    const originalById = new Map();
    for (const entry of originalOrders) {
      const oid = String(entry?.orderId || "");
      if (!oid) continue;
      const order = await Order.findById(oid)
        .populate("farmer", "name village")
        .populate("plantName", "name")
        .session(session);
      if (!order) {
        await session.abortTransaction();
        return next(new AppError(`Original order not found: ${oid}`, 404));
      }
      originalById.set(oid, order);
    }

    // Plants physically on the truck (across the referenced original orders).
    const vehiclePlants = [...originalById.values()].reduce(
      (sum, order) => sum + onVehicleQty(order),
      0
    );

    const totalReturned = originalOrders.reduce(
      (sum, e) => sum + Math.max(0, Number(e?.returnedQty) || 0),
      0
    );
    const totalReassigned = (newFarmers || []).reduce(
      (sum, f) => sum + Math.max(0, Number(f?.numberOfPlants) || 0),
      0
    );

    if (totalReassigned + totalReturned !== vehiclePlants) {
      await session.abortTransaction();
      return next(
        new AppError(
          `Plant count mismatch: reassigned (${totalReassigned}) + returned (${totalReturned}) must equal plants on vehicle (${vehiclePlants})`,
          400
        )
      );
    }

    // ---- 1. Original (refused) orders: status + slot release + ledger/history ----
    for (const entry of originalOrders) {
      const oid = String(entry?.orderId || "");
      const order = originalById.get(oid);
      if (!order) continue;

      const returnedQty = Math.max(0, Number(entry?.returnedQty) || 0);
      const disposition = String(entry?.disposition || "").toUpperCase();
      const keepOrder = disposition === "KEEP" || disposition === "ACCEPTED";

      // Plants that came back to the nursery release the booking slot.
      if (returnedQty > 0) {
        await releaseSlotQuantity(order, returnedQty, session);
      }

      const $set = {};
      const $push = {};

      if (keepOrder) {
        // Farmer still wants the plants — re-send later. Return to ready-for-dispatch.
        $set.orderStatus = "ACCEPTED";
        $set.remainingPlants =
          Number(order.numberOfPlants || 0) + Number(order.additionalPlants || 0);
        $set.currentDispatchId = null;
      } else {
        // Refused for now — temporary cancel reverses the receivable in the ledger.
        $set.orderStatus = TEMP_CANCELLED;
      }

      if (returnedQty > 0) {
        $set.returnedPlants =
          Math.max(0, Number(order.returnedPlants || 0)) + returnedQty;
        $push.returnHistory = {
          date: new Date(),
          quantity: returnedQty,
          reason: entry?.returnReason || "Refused delivery — returned to nursery",
          dispatchId: dispatch._id,
          processedBy: userId,
        };
      }

      const updateOperation = { $set };
      if (Object.keys($push).length > 0) updateOperation.$push = $push;

      await updateOrderWithLedgerSync({
        orderId: order._id,
        updateOperation,
        session,
        userId,
        existingDoc: order,
        contextLabel: "refused_reassign_original",
        req,
      });
    }

    // ---- 2. New "field" orders for the farmers who received the plants ----
    const createdFieldOrders = [];
    const reassignedFromOrderIds = [...originalById.keys()];

    for (const row of newFarmers || []) {
      const qty = Math.max(0, Number(row?.numberOfPlants) || 0);
      if (!(qty > 0)) {
        await session.abortTransaction();
        return next(new AppError("Each receiving farmer needs numberOfPlants > 0", 400));
      }

      const sourceOrder =
        originalById.get(String(row?.sourceOrderId || "")) ||
        [...originalById.values()][0];
      if (!sourceOrder) {
        await session.abortTransaction();
        return next(new AppError("Could not resolve source order for field order", 400));
      }

      const farmer = await resolveReassignFarmer(row, session);
      const rate =
        row.rate != null && row.rate !== "" ? Number(row.rate) : Number(sourceOrder.rate || 0);
      const salesPerson = userId || sourceOrder.salesPerson;
      if (!salesPerson) {
        await session.abortTransaction();
        return next(new AppError("Could not resolve salesPerson for field order", 400));
      }

      const orderId = await allocateNextOrderId(Order, { session });
      const nowIso = new Date();

      const orderDocument = {
        orderId,
        farmer: farmer._id,
        salesPerson,
        plantName: sourceOrder.plantName?._id || sourceOrder.plantName,
        plantSubtype: sourceOrder.plantSubtype,
        bookingSlot: sourceOrder.bookingSlot,
        cavity: sourceOrder.cavity,
        numberOfPlants: qty,
        remainingPlants: 0,
        rate,
        typeOfPlants: sourceOrder.typeOfPlants || "Regular",
        orderStatus: "COMPLETED",
        orderPaymentStatus: "PENDING",
        paymentStatus: "not paid",
        orderBookingDate: nowIso,
        orderDate: row.deliveryDate ? new Date(row.deliveryDate) : nowIso,
        deliveryDate: row.deliveryDate ? new Date(row.deliveryDate) : nowIso,
        isFieldReassignment: true,
        reassignedFromDispatchId: dispatch._id,
        reassignedFromOrderIds,
        currentDispatchId: dispatch._id,
        statusChanges: [
          {
            previousStatus: "PENDING",
            newStatus: "COMPLETED",
            reason: "Field order — refused delivery reassigned to this farmer",
            changedBy: userId,
            notes: `Plants handed over from dispatch ${dispatch.transportId ?? dispatch._id}`,
          },
        ],
      };

      const [createdOrder] = await Order.create([orderDocument], { session });

      // ORDER debit (central ledger shadow fires inside the helper).
      const orderForLedger =
        typeof createdOrder.toObject === "function"
          ? createdOrder.toObject()
          : { ...createdOrder };
      orderForLedger.farmer = farmer;
      await ensureFarmerPlantOrderDebit(orderForLedger, { userId, session });

      // Optional payment(s) collected on the field.
      const paymentSubdocs = buildDispatchCompletePaymentSubdocs(
        row.payment,
        req.user,
        { ...orderForLedger, farmer }
      );
      if (paymentSubdocs.length > 0) {
        createdOrder.payment.push(...paymentSubdocs);
        const collectedNow = sumCollectedFromNewPaymentSubdocs(paymentSubdocs);
        const gross = roundMoney(rate * qty);
        if (collectedNow >= gross && gross > 0) {
          createdOrder.orderPaymentStatus = "COMPLETED";
          createdOrder.paymentCompleted = true;
        }
        await createdOrder.save({ session });

        const farmerInfo = formatOrderWalletDescriptionContext({
          ...orderForLedger,
          farmer,
        });
        await applyWalletForDispatchNewPayments(
          { ...orderForLedger, farmer, _id: createdOrder._id },
          paymentSubdocs,
          farmerInfo,
          userId,
          session
        );

        for (const saved of createdOrder.payment.slice(-paymentSubdocs.length)) {
          if (saved.paymentStatus === "COLLECTED") {
            await recordFarmerPlantLedgerPaymentTransition(
              { ...orderForLedger, farmer, _id: createdOrder._id, payment: createdOrder.payment },
              saved,
              "PENDING",
              "COLLECTED",
              { userId, session }
            );
          }
        }
      }

      // Link the field order to the dispatch (no slot effect).
      dispatch.orderIds.addToSet
        ? dispatch.orderIds.addToSet(createdOrder._id)
        : dispatch.orderIds.push(createdOrder._id);
      dispatch.afterDispatchedOrderIds = dispatch.afterDispatchedOrderIds || [];
      dispatch.afterDispatchedOrderIds.push(createdOrder._id);
      dispatch.orderDispatchDetails = dispatch.orderDispatchDetails || [];
      dispatch.orderDispatchDetails.push({
        orderId: createdOrder._id,
        dispatchQuantity: qty,
        remainingAfterDispatch: 0,
        additionalPlants: 0,
        totalPlantsAfterAdjustments: qty,
        isPartialDispatch: false,
        driverName: dispatch.driverName || "",
        driverMobile: dispatch.driverMobile || "",
        vehicleName: dispatch.vehicleName || "",
      });

      createdFieldOrders.push(createdOrder);
    }

    // ---- 3. Dispatch-level updates (returns + transport status + optional trip) ----
    dispatch.returnedPlants =
      Math.max(0, Number(dispatch.returnedPlants || 0)) + totalReturned;
    dispatch.transportStatus = "DELIVERED";
    await dispatch.save({ session });

    await session.commitTransaction();

    const response = generateResponse(
      "Success",
      "Refused delivery reassigned: original orders updated and field orders created",
      {
        dispatch,
        fieldOrders: createdFieldOrders,
      }
    );
    return res.status(200).json(response);
  } catch (error) {
    await session.abortTransaction();
    return next(error);
  } finally {
    session.endSession();
  }
});

export default { reassignRefusedDelivery };
