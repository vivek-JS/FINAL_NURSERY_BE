import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import {
  listGlobalDocumentSequences,
  setGlobalDocumentSequence,
  migrateGlobalSequencesFromPlantKeys,
} from "../services/invoiceSequence.service.js";

export const getDeliveryChallanInvoiceSequence = catchAsync(async (req, res) => {
  const data = await listGlobalDocumentSequences();
  res.status(200).json(generateResponse("Success", "Document sequence settings", data));
});

export const putDeliveryChallanInvoiceSequence = catchAsync(async (req, res, next) => {
  const prefix = req.body?.prefix;
  const nextNumber = req.body?.nextNumber;
  const kindRaw = req.body?.kind ?? req.body?.sequenceKind ?? req.body?.type ?? "dc";
  const billableRaw = req.body?.billable ?? req.body?.bucket ?? true;
  let billable = true;
  if (billableRaw === false || billableRaw === "false" || billableRaw === "nonBillable") {
    billable = false;
  } else if (billableRaw === "billable") {
    billable = true;
  }

  if (nextNumber !== undefined && nextNumber !== null) {
    const nn = Number(nextNumber);
    if (!Number.isFinite(nn) || nn < 1 || !Number.isInteger(nn)) {
      return next(new AppError("nextNumber must be a positive integer", 400));
    }
  }

  if (prefix !== undefined && prefix !== null && String(prefix).trim() === "") {
    return next(new AppError("prefix cannot be empty (omit to keep current)", 400));
  }

  const data = await setGlobalDocumentSequence({
    kind: kindRaw,
    billable,
    prefix,
    nextNumber,
  });

  const kindLabel = data?.kind === "invoice" ? "invoice" : "DC";
  res.status(200).json(
    generateResponse(
      "Success",
      `Global ${kindLabel} sequence (${billable ? "billable" : "non-billable"}) updated. Existing issued numbers on orders are unchanged.`,
      data
    )
  );
});

/** @deprecated Plant-scoped sequences removed — returns empty list */
export const getPlantInvoiceSequences = catchAsync(async (req, res) => {
  res.status(200).json(
    generateResponse("Success", "Plant sequences deprecated; use global invoice-sequence API", [])
  );
});

/** @deprecated Redirects to global bucket update when plantId omitted */
export const putPlantInvoiceSequence = catchAsync(async (req, res, next) => {
  const plantId = req.body?.plantId || req.params?.plantId;
  if (plantId) {
    return next(
      new AppError(
        "Per-plant sequences are no longer supported. Use PUT /invoice-sequence with kind and billable.",
        400
      )
    );
  }
  return putDeliveryChallanInvoiceSequence(req, res, next);
});

export const postMigrateGlobalSequences = catchAsync(async (req, res) => {
  await migrateGlobalSequencesFromPlantKeys();
  const data = await listGlobalDocumentSequences();
  res.status(200).json(
    generateResponse("Success", "Global sequences migrated from legacy plant counters", data)
  );
});
