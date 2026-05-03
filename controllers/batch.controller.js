import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantOutward from "../models/plantOutward.model.js";

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
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
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

  if ((pChanged || sChanged) && !String(plantReadyDaysChangeReason || "").trim()) {
    return next(new AppError("Reason required when changing plant ready days", 400));
  }

  if ((pChanged || sChanged) && String(plantReadyDaysChangeReason || "").trim()) {
    const audit = [...(existing.plantReadyDaysAudit || [])];
    const reason = String(plantReadyDaysChangeReason).trim();
    if (pChanged) {
      audit.push({
        field: "primaryPlantReadyDays",
        oldValue: existing.primaryPlantReadyDays,
        newValue: Number(primaryPlantReadyDays),
        reason,
      });
    }
    if (sChanged) {
      audit.push({
        field: "secondaryPlantReadyDays",
        oldValue: existing.secondaryPlantReadyDays,
        newValue: Number(secondaryPlantReadyDays),
        reason,
      });
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
