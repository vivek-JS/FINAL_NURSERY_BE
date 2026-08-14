import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import {
  getPurchaseReturnableBatches,
  getSupplierReturnableBatches,
  listEligiblePurchaseOrdersForReturn,
  listEligibleSuppliersForReturn,
  listPurchaseReturns,
  processPurchaseReturn,
} from "../services/purchaseReturn.service.js";

export const listEligiblePos = catchAsync(async (req, res, next) => {
  const result = await listEligiblePurchaseOrdersForReturn({
    search: req.query.search,
    limit: req.query.limit,
  });
  if (!result.ok) return next(new AppError(result.error || "Failed", result.status || 400));
  return res.status(200).json(generateResponse("Success", "Eligible purchase orders", result.data));
});

export const listEligibleSuppliers = catchAsync(async (req, res, next) => {
  const result = await listEligibleSuppliersForReturn({
    search: req.query.search,
    limit: req.query.limit,
  });
  if (!result.ok) return next(new AppError(result.error || "Failed", result.status || 400));
  return res.status(200).json(generateResponse("Success", "Eligible suppliers", result.data));
});

export const getReturnableBatches = catchAsync(async (req, res, next) => {
  const supplierId = req.query.supplierId;
  const purchaseOrderId = req.query.purchaseOrderId || req.params.purchaseOrderId;

  if (supplierId) {
    const result = await getSupplierReturnableBatches(supplierId);
    if (!result.ok) return next(new AppError(result.error || "Failed", result.status || 400));
    return res.status(200).json(generateResponse("Success", "Supplier returnable batches", result.data));
  }

  const result = await getPurchaseReturnableBatches(purchaseOrderId);
  if (!result.ok) return next(new AppError(result.error || "Failed", result.status || 400));
  return res.status(200).json(generateResponse("Success", "Returnable batches", result.data));
});

export const createPurchaseReturn = catchAsync(async (req, res, next) => {
  const userId = req.user?._id || req.user?.id;
  if (!userId) return next(new AppError("Authentication required", 401));
  const { purchaseOrderId, supplierId, batchReturns, returnReason, returnNotes } = req.body || {};

  if (!supplierId && !purchaseOrderId) {
    return next(new AppError("supplierId or purchaseOrderId is required", 400));
  }

  const result = await processPurchaseReturn({
    purchaseOrderId,
    supplierId,
    batchReturns,
    returnReason,
    returnNotes,
    userId,
  });
  if (!result.ok) return next(new AppError(result.error || "Purchase return failed", result.status || 400));
  return res.status(201).json(
    generateResponse("Success", result.warning || "Purchase return completed", {
      ...((result.data && result.data.toObject?.()) || result.data || {}),
      ledgerStatus: result.ledgerStatus || result.data?.ledgerStatus,
      ledgerError: result.ledgerError,
      warning: result.warning,
    })
  );
});

export const listReturns = catchAsync(async (req, res, next) => {
  const result = await listPurchaseReturns(req.query || {});
  if (!result.ok) return next(new AppError(result.error || "Failed", result.status || 400));
  return res.status(200).json(generateResponse("Success", "Purchase returns", result.data));
});

/** GET PDF purchase-return invoice (download). */
export const downloadPurchaseReturnInvoice = catchAsync(async (req, res, next) => {
  const { buildPurchaseReturnInvoicePdf } = await import("../services/returnInvoicePdf.service.js");
  const result = await buildPurchaseReturnInvoicePdf(req.params.id);
  if (!result.ok) return next(new AppError(result.error || "Invoice failed", result.status || 400));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(result.buffer);
});
