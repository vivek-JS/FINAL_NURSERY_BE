import AgriSalesReturnRequest from "../models/agriSalesReturnRequest.model.js";

/**
 * Persist an office / order-detail sale return so it appears on Sell Returns list.
 */
export async function createOrderWiseSaleReturnAudit({
  order,
  returnQuantity,
  creditAmount = 0,
  returnReason = "",
  returnNotes = "",
  userId,
  stockReturned = false,
  lineReturns = [],
  appliedBatches = [],
} = {}) {
  if (!order?._id || !(Number(returnQuantity) > 0)) return null;
  try {
    return await AgriSalesReturnRequest.create({
      orderId: order._id,
      orderNumber: order.orderNumber,
      source: "ORDER_WISE",
      affectedOrders: [
        {
          orderId: order._id,
          orderNumber: order.orderNumber,
          customerName: order.customerName || "",
          returnQuantity: Number(returnQuantity) || 0,
          creditAmount: Number(creditAmount) || 0,
        },
      ],
      appliedBatches,
      dealer: order.dealer || userId,
      status: "APPROVED",
      lineReturns,
      returnReason: returnReason || "Order sale return",
      returnNotes: returnNotes || "",
      requestedBy: userId,
      reviewedBy: userId,
      reviewedAt: new Date(),
      reviewNotes: "Office order-wise sale return",
      stockReturned: !!stockReturned,
      creditAmount: Number(creditAmount) || 0,
    });
  } catch (e) {
    console.error("[createOrderWiseSaleReturnAudit]", e?.message || e);
    return null;
  }
}
