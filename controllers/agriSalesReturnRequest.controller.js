import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import mongoose from "mongoose";
import AgriSalesOrder, {
  getAgriOrderLines,
  computeAgriReturnCreditAmount,
} from "../models/agriSalesOrder.model.js";
import AgriSalesReturnRequest from "../models/agriSalesReturnRequest.model.js";
import { returnToExplicitBatches, returnToSourceBatches } from "../services/ramAgriBatchInventory.service.js";
import { createCustomerLedgerEntry } from "../utils/ramAgriLedgerHelper.js";
import { isAgriDealerSelf } from "../utils/agriDealerOrder.util.js";
import RamAgriBatch from "../models/ramAgriBatch.model.js";
import {
  getMerchantReturnableBatches,
  isOfficeReturnUser,
  processMerchantBatchReturn,
} from "../services/agriMerchantBatchReturn.service.js";

function getLineBatchAllocations(order, lineIndex) {
  if (Array.isArray(order.lineItems) && order.lineItems.length > lineIndex) {
    return order.lineItems[lineIndex].batchAllocations || [];
  }
  if (lineIndex === 0 && Array.isArray(order.batchAllocations)) {
    return order.batchAllocations;
  }
  return [];
}

function maxReturnableForLine(order, lineIndex) {
  const lines = getAgriOrderLines(order);
  const line = lines[lineIndex];
  if (!line) return 0;
  const delivered = Number(line.quantity) || 0;
  const alreadyReturned = Number(line.returnQuantity) || 0;
  return Math.max(0, delivered - alreadyReturned);
}

function buildReturnableBatchSummary(order) {
  const lines = getAgriOrderLines(order);
  return lines.map((line, li) => {
    const allocations = getLineBatchAllocations(order, li);
    const lineItemId = order.lineItems?.[li]?._id;
    return {
      lineItemId,
      ramAgriVarietyId: line.ramAgriVarietyId,
      productName: line.productName,
      deliveredQuantity: Number(line.quantity) || 0,
      returnQuantity: Number(line.returnQuantity) || 0,
      maxReturnQuantity: maxReturnableForLine(order, li),
      batchAllocations: allocations.map((a) => ({
        batchId: a.batchId,
        batchNumber: a.batchNumber,
        quantityDeducted: Number(a.quantityDeducted) || 0,
        quantityReturned: Number(a.quantityReturned) || 0,
        maxReturnQuantity: Math.max(
          0,
          (Number(a.quantityDeducted) || 0) - (Number(a.quantityReturned) || 0)
        ),
      })),
    };
  });
}

export const getAgriOrderBatchSummary = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID", 400));
  }
  const order = await AgriSalesOrder.findById(id).lean();
  if (!order) return next(new AppError("Order not found", 404));

  const batchIds = [];
  for (const line of buildReturnableBatchSummary(order)) {
    for (const b of line.batchAllocations) {
      if (b.batchId) batchIds.push(b.batchId);
    }
  }
  const batchDocs = batchIds.length
    ? await RamAgriBatch.find({ _id: { $in: batchIds } }).select("batchNumber expiryDate").lean()
    : [];
  const expiryMap = Object.fromEntries(batchDocs.map((b) => [String(b._id), b.expiryDate]));

  const lines = buildReturnableBatchSummary(order).map((line) => ({
    ...line,
    batchAllocations: line.batchAllocations.map((b) => ({
      ...b,
      expiryDate: expiryMap[String(b.batchId)] || null,
    })),
  }));

  return res.status(200).json(
    generateResponse("Success", "Batch summary", {
      orderId: order._id,
      orderNumber: order.orderNumber,
      lines,
    })
  );
});

export const requestAgriSalesReturn = catchAsync(async (req, res, next) => {
  const userId = req.user?._id || req.user?.id;
  if (!userId) return next(new AppError("Authentication required", 401));
  if (!isAgriDealerSelf(req.user)) {
    return next(new AppError("Only dealers can submit sales return requests", 403));
  }

  const { orderId, lineReturns, returnReason, returnNotes } = req.body;
  if (!orderId || !mongoose.isValidObjectId(orderId)) {
    return next(new AppError("Valid orderId is required", 400));
  }
  if (!Array.isArray(lineReturns) || lineReturns.length === 0) {
    return next(new AppError("At least one line return is required", 400));
  }

  const order = await AgriSalesOrder.findById(orderId);
  if (!order) return next(new AppError("Order not found", 404));
  if (String(order.dealer || order.createdBy) !== String(userId) && !order.isDealerSelfOrder) {
    return next(new AppError("You can only return your own dealer orders", 403));
  }
  if (order.dispatchStatus === "NOT_DISPATCHED") {
    return next(new AppError("Order must be dispatched before return", 400));
  }

  const existingPending = await AgriSalesReturnRequest.findOne({
    orderId,
    status: "PENDING",
  });
  if (existingPending) {
    return next(new AppError("A pending return request already exists for this order", 400));
  }

  const lines = getAgriOrderLines(order);
  const normalizedLineReturns = [];

  for (const lr of lineReturns) {
    const returnQty = Number(lr.returnQuantity) || 0;
    if (returnQty <= 0) continue;

    let lineIndex = -1;
    if (lr.lineItemId && order.lineItems?.length) {
      lineIndex = order.lineItems.findIndex((li) => String(li._id) === String(lr.lineItemId));
    }
    if (lineIndex < 0 && lr.ramAgriVarietyId) {
      lineIndex = lines.findIndex((l) => String(l.ramAgriVarietyId) === String(lr.ramAgriVarietyId));
    }
    if (lineIndex < 0) lineIndex = 0;

    const maxLine = maxReturnableForLine(order, lineIndex);
    if (returnQty > maxLine) {
      return next(new AppError(`Return qty exceeds max ${maxLine} for line`, 400));
    }

    const allocations = getLineBatchAllocations(order, lineIndex);
    const batchReturns = (lr.batchReturns || []).map((br) => ({
      batchId: br.batchId,
      batchNumber: br.batchNumber,
      quantity: Number(br.quantity) || 0,
    }));
    const batchTotal = batchReturns.reduce((s, b) => s + b.quantity, 0);
    if (batchReturns.length > 0 && Math.abs(batchTotal - returnQty) > 0.001) {
      return next(new AppError("Batch return quantities must sum to line return quantity", 400));
    }
    for (const br of batchReturns) {
      const alloc = allocations.find((a) => String(a.batchId) === String(br.batchId));
      if (!alloc) return next(new AppError(`Invalid batch ${br.batchId} for line`, 400));
      const maxBatch =
        (Number(alloc.quantityDeducted) || 0) - (Number(alloc.quantityReturned) || 0);
      if (br.quantity > maxBatch) {
        return next(new AppError(`Batch return exceeds max ${maxBatch}`, 400));
      }
    }

    normalizedLineReturns.push({
      lineItemId: order.lineItems?.[lineIndex]?._id,
      ramAgriVarietyId: lines[lineIndex]?.ramAgriVarietyId,
      productName: lines[lineIndex]?.productName,
      returnQuantity: returnQty,
      batchReturns,
    });
  }

  if (normalizedLineReturns.length === 0) {
    return next(new AppError("No valid return quantities provided", 400));
  }

  const doc = await AgriSalesReturnRequest.create({
    orderId,
    orderNumber: order.orderNumber,
    dealer: userId,
    status: "PENDING",
    lineReturns: normalizedLineReturns,
    returnReason: returnReason?.trim() || "",
    returnNotes: returnNotes?.trim() || "",
    requestedBy: userId,
  });

  return res.status(201).json(generateResponse("Success", "Return request submitted", doc));
});

export const listAgriSalesReturnRequests = catchAsync(async (req, res, next) => {
  const { status = "PENDING", page = 1, limit = 50 } = req.query;
  const filter = {};
  if (status && status !== "ALL") filter.status = status;

  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  const [data, total] = await Promise.all([
    AgriSalesReturnRequest.find(filter)
      .populate("dealer", "name phoneNumber")
      .populate("requestedBy", "name phoneNumber")
      .populate("reviewedBy", "name phoneNumber")
      .sort({ requestedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10))
      .lean(),
    AgriSalesReturnRequest.countDocuments(filter),
  ]);

  return res.status(200).json(
    generateResponse("Success", "Return requests", {
      data,
      pagination: { total, page: parseInt(page, 10), limit: parseInt(limit, 10) },
    })
  );
});

export const approveAgriSalesReturnRequest = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { reviewNotes } = req.body;
  const userId = req.user?._id || req.user?.id;

  if (!mongoose.isValidObjectId(id)) return next(new AppError("Invalid request ID", 400));

  const request = await AgriSalesReturnRequest.findById(id);
  if (!request) return next(new AppError("Return request not found", 404));
  if (request.status !== "PENDING") {
    return next(new AppError(`Request is already ${request.status}`, 400));
  }

  const order = await AgriSalesOrder.findById(request.orderId);
  if (!order) return next(new AppError("Order not found", 404));

  const lines = getAgriOrderLines(order);
  let totalReturnQty = 0;
  let creditAmount = 0;

  for (const lr of request.lineReturns) {
    let lineIndex = -1;
    if (lr.lineItemId && order.lineItems?.length) {
      lineIndex = order.lineItems.findIndex((li) => String(li._id) === String(lr.lineItemId));
    }
    if (lineIndex < 0 && lr.ramAgriVarietyId) {
      lineIndex = lines.findIndex((l) => String(l.ramAgriVarietyId) === String(lr.ramAgriVarietyId));
    }
    if (lineIndex < 0) lineIndex = 0;

    const line = lines[lineIndex];
    const allocations = getLineBatchAllocations(order, lineIndex).map((a) => ({
      batchId: a.batchId,
      batchNumber: a.batchNumber,
      quantityDeducted: Number(a.quantityDeducted) || 0,
      quantityReturned: Number(a.quantityReturned) || 0,
    }));
    const returnQty = Number(lr.returnQuantity) || 0;
    if (returnQty <= 0) continue;

    const batchReturns = (lr.batchReturns || []).filter((b) => Number(b.quantity) > 0);
    let result;
    if (batchReturns.length > 0) {
      result = await returnToExplicitBatches(allocations, batchReturns, {
        cropId: line.ramAgriCropId,
        varietyId: line.ramAgriVarietyId,
        orderId: order._id,
        orderNumber: order.orderNumber,
        userId,
        reason: request.returnReason,
        movementType: "DEALER_RETURN_IN",
        description: `Dealer return — ${order.orderNumber || order._id}`,
      });
    } else {
      result = await returnToSourceBatches(allocations, returnQty, {
        cropId: line.ramAgriCropId,
        varietyId: line.ramAgriVarietyId,
        orderId: order._id,
        orderNumber: order.orderNumber,
        userId,
        reason: request.returnReason,
        movementType: "DEALER_RETURN_IN",
        description: `Dealer return — ${order.orderNumber || order._id}`,
      });
    }

    if (!result.ok) return next(new AppError(result.error || "Stock restore failed", 400));

    if (order.lineItems?.[lineIndex]) {
      order.lineItems[lineIndex].batchAllocations = allocations;
      order.lineItems[lineIndex].returnQuantity =
        (Number(order.lineItems[lineIndex].returnQuantity) || 0) + returnQty;
      order.markModified("lineItems");
    } else if (lineIndex === 0) {
      order.batchAllocations = allocations;
      order.markModified("batchAllocations");
    }

    totalReturnQty += returnQty;
    creditAmount += computeAgriReturnCreditAmount(line, returnQty);
  }

  order.salesReturnQuantity = (Number(order.salesReturnQuantity) || 0) + totalReturnQty;
  order.balanceAmount = Math.max(0, (Number(order.balanceAmount) || 0) - creditAmount);
  if (order.balanceAmount <= 0 && order.paymentStatus !== "PAID") {
    order.paymentStatus = order.totalPaidAmount >= order.totalAmount ? "PAID" : order.paymentStatus;
  }
  await order.save();

  const ledgerEntry = await createCustomerLedgerEntry({
    customerMobile: order.customerMobile,
    customerName: order.customerName,
    refType: "SALES_RETURN",
    refId: request._id,
    orderId: order._id,
    credit: creditAmount,
    reference: order.orderNumber,
    category: "Sales Return",
    description: `Sales return approved for order ${order.orderNumber}`,
    entryDate: new Date(),
    createdBy: userId,
    metadata: { returnRequestId: request._id, totalReturnQty },
  });

  request.status = "APPROVED";
  request.reviewedBy = userId;
  request.reviewedAt = new Date();
  request.reviewNotes = reviewNotes?.trim() || "";
  request.stockReturned = true;
  request.creditAmount = creditAmount;
  request.ledgerRefId = ledgerEntry?._id;
  await request.save();

  return res.status(200).json(generateResponse("Success", "Return approved", { request, order }));
});

export const rejectAgriSalesReturnRequest = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { reviewNotes } = req.body;
  const userId = req.user?._id || req.user?.id;

  if (!mongoose.isValidObjectId(id)) return next(new AppError("Invalid request ID", 400));

  const request = await AgriSalesReturnRequest.findById(id);
  if (!request) return next(new AppError("Return request not found", 404));
  if (request.status !== "PENDING") {
    return next(new AppError(`Request is already ${request.status}`, 400));
  }

  request.status = "REJECTED";
  request.reviewedBy = userId;
  request.reviewedAt = new Date();
  request.reviewNotes = reviewNotes?.trim() || "";
  await request.save();

  return res.status(200).json(generateResponse("Success", "Return rejected", request));
});

export const getAgriSalesReturnRequestsForOrder = catchAsync(async (req, res, next) => {
  const { orderId } = req.params;
  if (!mongoose.isValidObjectId(orderId)) {
    return next(new AppError("Invalid order ID", 400));
  }
  const data = await AgriSalesReturnRequest.find({ orderId })
    .sort({ requestedAt: -1 })
    .lean();
  return res.status(200).json(generateResponse("Success", "Return requests for order", data));
});

/** GET returnable batches aggregated for a B2B merchant (office). */
export const getMerchantReturnableBatchesHandler = catchAsync(async (req, res, next) => {
  if (!isOfficeReturnUser(req.user)) {
    return next(new AppError("Only office roles can view merchant returnable batches", 403));
  }
  const merchantId = req.query.merchantId;
  const result = await getMerchantReturnableBatches(merchantId);
  if (!result.ok) {
    return next(new AppError(result.error || "Failed to load batches", result.status || 400));
  }
  return res.status(200).json(generateResponse("Success", "Merchant returnable batches", result.data));
});

/** POST immediate merchant-batch sale return (office): stock + ledger + merchant money. */
export const processMerchantBatchReturnHandler = catchAsync(async (req, res, next) => {
  if (!isOfficeReturnUser(req.user)) {
    return next(new AppError("Only office roles can process merchant batch returns", 403));
  }
  if (isAgriDealerSelf(req.user)) {
    return next(new AppError("Dealers cannot use office merchant-batch return", 403));
  }
  const userId = req.user?._id || req.user?.id;
  const { merchantId, batchReturns, returnReason, returnNotes } = req.body || {};
  const result = await processMerchantBatchReturn({
    merchantId,
    batchReturns,
    returnReason,
    returnNotes,
    userId,
  });
  if (!result.ok) {
    return next(new AppError(result.error || "Merchant batch return failed", result.status || 400));
  }
  return res
    .status(200)
    .json(generateResponse("Success", "Merchant batch sale return applied", result.data));
});
