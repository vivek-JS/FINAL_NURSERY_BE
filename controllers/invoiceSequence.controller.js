import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import {
  getInvoiceSequenceSettings,
  setInvoiceSequenceSettings,
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
