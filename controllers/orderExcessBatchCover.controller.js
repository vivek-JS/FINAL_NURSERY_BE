import mongoose from "mongoose";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import { isOfficeOrSuper } from "./orderSowFromExcess.controller.js";
import { deliveryDateToIstMoment } from "../utility/istSlotDate.js";
import {
  EXCESS_COVER_WINDOW_DAYS,
  ExcessCoverError,
  coverOrderFromBatches,
  listExcessBatches,
  ownSowTolerance,
  suggestExcessDays,
} from "../services/orderExcessBatchCover.service.js";

/** Plant ready days of the subtype and whether a sowing started today is ready by delivery. */
async function newSowingInfo(plantId, subtypeId, deliveryDate) {
  const plant = await PlantCms.findById(plantId).select("subtypes._id subtypes.plantReadyDays").lean();
  const subtype = (plant?.subtypes || []).find((s) => String(s._id) === String(subtypeId));
  const plantReadyDays = Math.max(0, Math.floor(Number(subtype?.plantReadyDays) || 0));
  const delivery = deliveryDateToIstMoment(deliveryDate);
  const readyBy = deliveryDateToIstMoment(new Date())?.add(plantReadyDays, "days");
  return {
    plantReadyDays,
    newSowingReadyBy: readyBy ? readyBy.format("DD-MM-YYYY") : null,
    newSowingPossible: Boolean(delivery && readyBy && !delivery.isBefore(readyBy)),
  };
}

function sendError(res, err, fallback) {
  if (err instanceof ExcessCoverError) {
    return res.status(err.statusCode || 400).json({
      success: false,
      code: err.code,
      message: err.message,
    });
  }
  console.error(fallback, err);
  return res.status(500).json({ success: false, message: err?.message || fallback });
}

/**
 * GET /sowing/excess-batches?plantId&subtypeId&deliveryDate&need&windowDays=5
 * Booking-time preview: free excess per sowing batch within delivery ±windowDays (IST).
 */
export const getExcessBatches = async (req, res) => {
  try {
    const { plantId, subtypeId, deliveryDate, need, windowDays, releaseOrderId } = req.query;
    if (
      !mongoose.Types.ObjectId.isValid(String(plantId || "")) ||
      !mongoose.Types.ObjectId.isValid(String(subtypeId || ""))
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Valid plantId and subtypeId are required" });
    }
    if (!deliveryDate) {
      return res.status(400).json({ success: false, message: "deliveryDate is required" });
    }
    const releaseId = mongoose.Types.ObjectId.isValid(String(releaseOrderId || ""))
      ? String(releaseOrderId)
      : null;
    const data = await listExcessBatches({
      plantId,
      subtypeId,
      deliveryDate,
      need,
      windowDays: windowDays ?? EXCESS_COVER_WINDOW_DAYS,
      releaseOrderId: releaseId,
    });
    Object.assign(data, await newSowingInfo(plantId, subtypeId, deliveryDate));
    if (data.windowDays >= 15 && data.need > 0 && data.totalFree < data.need) {
      data.suggestedDays = await suggestExcessDays({
        plantId,
        subtypeId,
        deliveryDate,
        need: data.need,
        releaseOrderId: releaseId,
      });
    }
    if (releaseId) {
      const order = await Order.findById(releaseId)
        .select(
          "orderId deliveryDate sowingDone sowingDoneRequestId sowingCoverSources sowingCoverReversedAt"
        )
        .lean();
      data.ownSow = order ? await ownSowTolerance(order, deliveryDate) : null;
    }
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendError(res, err, "Failed to load excess sowing batches");
  }
};

/**
 * POST /sowing/order/:orderId/cover-from-batches  body: { picks: [{ batchId, slotId, plants }] }
 * Retry path from order details. Office/Super admin or the order's salesperson.
 */
export const coverOrderFromExcessBatches = async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(orderId || ""))) {
      return res.status(400).json({ success: false, message: "Valid order id is required" });
    }
    const order = await Order.findById(orderId)
      .select("salesPerson orderStatus dealerOrder productMappingId")
      .lean();
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const isOwner = String(order.salesPerson || "") === String(req.user?._id || "");
    if (!isOfficeOrSuper(req.user) && !isOwner) {
      return res.status(403).json({
        success: false,
        message: "Only Office Admin, Super Admin or the order's salesperson can cover this order",
      });
    }
    if (order.dealerOrder || order.productMappingId) {
      return res.status(400).json({
        success: false,
        message: "Excess cover is only for sowing farmer orders",
      });
    }
    if (["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"].includes(String(order.orderStatus))) {
      return res.status(400).json({ success: false, message: "Order is cancelled" });
    }

    const rawWindow = Math.floor(Number(req.body?.windowDays) || EXCESS_COVER_WINDOW_DAYS);
    const result = await coverOrderFromBatches({
      order: order._id,
      picks: req.body?.picks,
      userId: req.user?._id,
      windowDays: Math.min(15, Math.max(1, rawWindow)),
    });
    return res.status(200).json({
      success: true,
      message: `Order #${result.orderId} marked sow completed from excess`,
      data: result,
    });
  } catch (err) {
    return sendError(res, err, "Failed to cover order from excess batches");
  }
};
