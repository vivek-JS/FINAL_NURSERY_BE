import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import {
  getInvoiceSequenceSettings,
  setInvoiceSequenceSettings,
  listPlantInvoiceSequences,
  setPlantInvoiceSequence,
} from "../services/invoiceSequence.service.js";

export const getDeliveryChallanInvoiceSequence = catchAsync(async (req, res) => {
  const data = await getInvoiceSequenceSettings();
  res.status(200).json(generateResponse("Success", "Invoice sequence settings", data));
});

export const putDeliveryChallanInvoiceSequence = catchAsync(async (req, res, next) => {
  const prefix = req.body?.prefix;
  const nextNumber = req.body?.nextNumber;

  if (nextNumber !== undefined && nextNumber !== null) {
    const nn = Number(nextNumber);
    if (!Number.isFinite(nn) || nn < 1 || !Number.isInteger(nn)) {
      return next(new AppError("nextNumber must be a positive integer", 400));
    }
  }

  if (prefix !== undefined && prefix !== null && String(prefix).trim() === "") {
    return next(new AppError("prefix cannot be empty (omit to keep current)", 400));
  }

  const current = await getInvoiceSequenceSettings();
  const data = await setInvoiceSequenceSettings({
    prefix: prefix !== undefined ? prefix : current.prefix,
    nextNumber: nextNumber !== undefined && nextNumber !== null ? nextNumber : current.nextNumber,
  });

  res.status(200).json(
    generateResponse(
      "Success",
      "Invoice sequence updated. Existing issued numbers on orders are unchanged.",
      data
    )
  );
});

export const getPlantInvoiceSequences = catchAsync(async (req, res) => {
  const data = await listPlantInvoiceSequences();
  res.status(200).json(generateResponse("Success", "Plant invoice sequences", data));
});

export const putPlantInvoiceSequence = catchAsync(async (req, res, next) => {
  const plantId = req.body?.plantId || req.params?.plantId;
  const prefix = req.body?.prefix;
  const nextNumber = req.body?.nextNumber;

  if (!plantId) {
    return next(new AppError("plantId is required", 400));
  }
  if (nextNumber !== undefined && nextNumber !== null) {
    const nn = Number(nextNumber);
    if (!Number.isFinite(nn) || nn < 1 || !Number.isInteger(nn)) {
      return next(new AppError("nextNumber must be a positive integer", 400));
    }
  }
  if (prefix !== undefined && prefix !== null && String(prefix).trim() === "") {
    return next(new AppError("prefix cannot be empty", 400));
  }

  try {
    const data = await setPlantInvoiceSequence({ plantId, prefix, nextNumber });
    res.status(200).json(
      generateResponse(
        "Success",
        "Plant invoice sequence updated. Existing issued numbers on orders are unchanged. Cancelled legs do not free numbers.",
        data
      )
    );
  } catch (e) {
    return next(new AppError(e.message || "Failed to update plant sequence", e.statusCode || 400));
  }
});
