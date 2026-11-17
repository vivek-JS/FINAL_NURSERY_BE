import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantOutward from "../models/plantOutward.model.js";

const DEFAULT_R2_READY_DAYS = 40;
const DEFAULT_R3_READY_DAYS = 40;

function positiveDay(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? n : 0;
}

async function assertSubtypeBelongsToPlant(plantCmsId, plantSubtypeId) {
  if (!plantCmsId || !plantSubtypeId) return;
  const plant = await PlantCms.findById(plantCmsId).select("subtypes").lean();
  if (!plant) throw new AppError("Plant not found", 400);
  const ok = (plant.subtypes || []).some((s) => String(s._id) === String(plantSubtypeId));
  if (!ok) throw new AppError("Subtype does not belong to selected plant", 400);
}

export const createBatch = catchAsync(async (req, res, next) => {
  const {
    batchNumber,
    dateAdded,
    primaryPlantReadyDays,
    secondaryPlantReadyDays,
    secondaryR2PlantReadyDays,
    secondaryR3PlantReadyDays,
    plantCmsId,
    plantSubtypeId,
  } = req.body;

  if (!plantCmsId || !plantSubtypeId) {
    return next(new AppError("Plant and subtype are required", 400));
  }
  if (!mongoose.isValidObjectId(plantCmsId) || !mongoose.isValidObjectId(plantSubtypeId)) {
    return next(new AppError("Invalid plant or subtype id", 400));
  }
  await assertSubtypeBelongsToPlant(plantCmsId, plantSubtypeId);

  const dup = await DispatchBatch.findOne({
    batchNumber: String(batchNumber).trim(),
  });
  if (dup) return next(new AppError("Batch number already exists", 400));

  const doc = await DispatchBatch.create({
    batchNumber: String(batchNumber).trim(),
    dateAdded: dateAdded ? new Date(dateAdded) : new Date(),
    primaryPlantReadyDays: Number(primaryPlantReadyDays),
    secondaryPlantReadyDays: Number(secondaryPlantReadyDays),
    secondaryR2PlantReadyDays: positiveDay(secondaryR2PlantReadyDays) || DEFAULT_R2_READY_DAYS,
    secondaryR3PlantReadyDays: positiveDay(secondaryR3PlantReadyDays) || DEFAULT_R3_READY_DAYS,
    plantCmsId,
    plantSubtypeId,
  });

  /** One PlantOutward shell per dispatch batch — lab/primary/secondary flows key off this doc */
  let poShell = await PlantOutward.findOne({ batchId: doc._id });
  if (!poShell) {
    try {
      poShell = await PlantOutward.create({
        batchId: doc._id,
        dateAdded: doc.dateAdded || new Date(),
      });
    } catch (e) {
      await DispatchBatch.findByIdAndDelete(doc._id);
      throw e;
    }
  }

  const populated = await DispatchBatch.findById(doc._id)
    .populate("plantCmsId", "name subtypes")
    .lean();

  return res
    .status(201)
    .json(generateResponse("Success", "Batch created", populated, undefined));
});

export const getAllBatches = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const search = String(req.query.search || "").trim();
  const q = {};
  if (search) {
    q.batchNumber = { $regex: search, $options: "i" };
  }
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    DispatchBatch.find(q)
      .populate("plantCmsId", "name subtypes")
      .sort({ dateAdded: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    DispatchBatch.countDocuments(q),
  ]);

  return res.status(200).json(
    generateResponse("Success", "Batches loaded", {
      data: rows,
      pagination: { total, page, limit },
    })
  );
});

export const updateBatch = catchAsync(async (req, res, next) => {
  const {
    id,
    batchNumber,
    dateAdded,
    primaryPlantReadyDays,
    secondaryPlantReadyDays,
    secondaryR2PlantReadyDays,
    secondaryR3PlantReadyDays,
    plantReadyDaysChangeReason,
    plantCmsId,
    plantSubtypeId,
  } = req.body;

  if (!id || !mongoose.isValidObjectId(id)) {
    return next(new AppError("Valid batch id is required", 400));
  }

  const existing = await DispatchBatch.findById(id);
  if (!existing) return next(new AppError("Batch not found", 404));

  const patch = {};
  if (batchNumber != null) patch.batchNumber = String(batchNumber).trim();
  if (dateAdded != null) patch.dateAdded = new Date(dateAdded);
  if (primaryPlantReadyDays != null) patch.primaryPlantReadyDays = Number(primaryPlantReadyDays);
  if (secondaryPlantReadyDays != null) patch.secondaryPlantReadyDays = Number(secondaryPlantReadyDays);
  if (positiveDay(secondaryR2PlantReadyDays)) patch.secondaryR2PlantReadyDays = positiveDay(secondaryR2PlantReadyDays);
  if (positiveDay(secondaryR3PlantReadyDays)) patch.secondaryR3PlantReadyDays = positiveDay(secondaryR3PlantReadyDays);

  const nextPlant = plantCmsId ?? existing.plantCmsId;
  const nextSubtype = plantSubtypeId ?? existing.plantSubtypeId;
  if (plantCmsId != null || plantSubtypeId != null) {
    if (!nextPlant || !nextSubtype) {
      return next(new AppError("Plant and subtype must both be set when updating either", 400));
    }
    if (!mongoose.isValidObjectId(nextPlant) || !mongoose.isValidObjectId(nextSubtype)) {
      return next(new AppError("Invalid plant or subtype id", 400));
    }
    await assertSubtypeBelongsToPlant(nextPlant, nextSubtype);
    patch.plantCmsId = nextPlant;
    patch.plantSubtypeId = nextSubtype;
  }

  const pChanged =
    primaryPlantReadyDays != null &&
    Number(primaryPlantReadyDays) !== Number(existing.primaryPlantReadyDays);
  const sChanged =
    secondaryPlantReadyDays != null &&
    Number(secondaryPlantReadyDays) !== Number(existing.secondaryPlantReadyDays);
  const r2Next = positiveDay(secondaryR2PlantReadyDays);
  const r2Prev = positiveDay(existing.secondaryR2PlantReadyDays);
  const r3Next = positiveDay(secondaryR3PlantReadyDays);
  const r3Prev = positiveDay(existing.secondaryR3PlantReadyDays);
  const r2Changed = r2Next > 0 && r2Next !== r2Prev;
  const r3Changed = r3Next > 0 && r3Next !== r3Prev;
  const daysNeedReason =
    pChanged || sChanged || (r2Changed && r2Prev > 0) || (r3Changed && r3Prev > 0);

  if (daysNeedReason && !String(plantReadyDaysChangeReason || "").trim()) {
    return next(new AppError("Reason required when changing plant ready days", 400));
  }

  if ((pChanged || sChanged || r2Changed || r3Changed) && String(plantReadyDaysChangeReason || "").trim()) {
    const audit = [...(existing.plantReadyDaysAudit || [])];
    const reason = String(plantReadyDaysChangeReason).trim();
    const pushAudit = (field, oldValue, newValue) => {
      audit.push({ field, oldValue, newValue, reason });
    };
    if (pChanged) pushAudit("primaryPlantReadyDays", existing.primaryPlantReadyDays, Number(primaryPlantReadyDays));
    if (sChanged) pushAudit("secondaryPlantReadyDays", existing.secondaryPlantReadyDays, Number(secondaryPlantReadyDays));
    if (r2Changed) {
      pushAudit("secondaryR2PlantReadyDays", existing.secondaryR2PlantReadyDays, positiveDay(secondaryR2PlantReadyDays));
    }
    if (r3Changed) {
      pushAudit("secondaryR3PlantReadyDays", existing.secondaryR3PlantReadyDays, positiveDay(secondaryR3PlantReadyDays));
    }
    patch.plantReadyDaysAudit = audit;
  }

  const doc = await DispatchBatch.findByIdAndUpdate(id, patch, {
    new: true,
    runValidators: true,
  })
    .populate("plantCmsId", "name subtypes")
    .lean();

  return res.status(200).json(generateResponse("Success", "Batch updated", doc, undefined));
});

export const toggleBatchStatus = catchAsync(async (req, res, next) => {
  const { id, isActive } = req.body;
  if (!id || !mongoose.isValidObjectId(id)) {
    return next(new AppError("Valid batch id is required", 400));
  }
  const doc = await DispatchBatch.findByIdAndUpdate(
    id,
    { isActive: Boolean(isActive) },
    { new: true }
  ).populate("plantCmsId", "name subtypes");

  if (!doc) return next(new AppError("Batch not found", 404));
  return res.status(200).json(generateResponse("Success", "Batch status updated", doc, undefined));
});
