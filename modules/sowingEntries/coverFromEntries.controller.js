import mongoose from "mongoose";
import Order from "../../models/order.model.js";
import { isOfficeOrSuper } from "../../controllers/orderSowFromExcess.controller.js";
import { ExcessCoverError } from "../../services/orderExcessBatchCover.service.js";
import { coverOrderFromEntries } from "./coverFromEntries.service.js";

/** POST /sowing/order/:orderId/cover-from-entries  { picks: [{ entryId, plants }] } */
export async function postCoverFromEntries(req, res) {
  try {
    const { orderId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(orderId || ""))) {
      return res.status(400).json({ success: false, message: "Valid order id is required" });
    }
    const order = await Order.findById(orderId)
      .select("salesPerson orderStatus dealerOrder productMappingId")
      .lean();
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    const isOwner = String(order.salesPerson || "") === String(req.user?._id || "");
    if (!isOfficeOrSuper(req.user) && !isOwner) {
      return res.status(403).json({
        success: false,
        message: "Only Office Admin, Super Admin or the order's salesperson can cover this order",
      });
    }
    if (order.dealerOrder || order.productMappingId) {
      return res.status(400).json({ success: false, message: "Excess cover is only for sowing farmer orders" });
    }
    if (["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"].includes(String(order.orderStatus))) {
      return res.status(400).json({ success: false, message: "Order is cancelled" });
    }
    const rawNeed = Math.floor(Number(req.body?.additionalNeed) || 0);
    const result = await coverOrderFromEntries({
      order: order._id,
      picks: req.body?.picks,
      userId: req.user?._id,
      windowDays: Math.max(1, Math.floor(Number(req.body?.windowDays) || 3)),
      pastWindowDays: Math.max(0, Math.floor(Number(req.body?.pastWindowDays) || 12)),
      additionalNeed: rawNeed > 0 ? rawNeed : null,
    });
    return res.json({
      success: true,
      message: `Order #${result.orderId} marked sow completed from excess`,
      data: result,
    });
  } catch (err) {
    const code = err instanceof ExcessCoverError ? err.statusCode || 400 : 500;
    return res.status(code >= 400 && code < 600 ? code : 500).json({
      success: false,
      code: err?.code || null,
      message: err?.message || "Could not cover from the sowing collection",
    });
  }
}
