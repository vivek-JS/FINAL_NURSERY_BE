import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import NurserySite from "../models/nurserySite.model.js";
import mongoose from "mongoose";

const normalizeCode = (c) => String(c || "").trim().toUpperCase().replace(/\s+/g, "");

export const listNurserySites = catchAsync(async (req, res) => {
  const activeOnly = String(req.query.activeOnly || "") === "true" || String(req.query.activeOnly || "") === "1";
  const q = activeOnly ? { isActive: true } : {};
  const rows = await NurserySite.find(q).sort({ sortOrder: 1, name: 1 }).lean();
  return res.status(200).json(generateResponse("Success", "Nursery sites loaded", rows, undefined));
});

export const createNurserySite = catchAsync(async (req, res, next) => {
  const { name, code, sortOrder = 0, isActive = true } = req.body || {};
  if (!name || !String(name).trim()) return next(new AppError("name is required", 400));
  const c = normalizeCode(code);
  if (!c || c.length < 2) return next(new AppError("code is required (min 2 chars)", 400));
  const dup = await NurserySite.findOne({ code: c });
  if (dup) return next(new AppError("A site with this code already exists", 400));
  const doc = await NurserySite.create({
    name: String(name).trim(),
    code: c,
    sortOrder: Number(sortOrder) || 0,
    isActive: Boolean(isActive),
  });
  return res.status(201).json(generateResponse("Success", "Nursery site created", doc, undefined));
});

export const updateNurserySite = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return next(new AppError("Invalid id", 400));
  const patch = { ...req.body };
  if (patch.code != null) patch.code = normalizeCode(patch.code);
  delete patch._id;
  const doc = await NurserySite.findByIdAndUpdate(id, patch, { new: true, runValidators: true });
  if (!doc) return next(new AppError("Nursery site not found", 404));
  return res.status(200).json(generateResponse("Success", "Nursery site updated", doc, undefined));
});

export const deleteNurserySite = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return next(new AppError("Invalid id", 400));
  const doc = await NurserySite.findByIdAndUpdate(id, { isActive: false }, { new: true });
  if (!doc) return next(new AppError("Nursery site not found", 404));
  return res.status(200).json(generateResponse("Success", "Nursery site deactivated", doc, undefined));
});
