import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";
import RamAgriDailyClosingStock from "../models/ramAgriDailyClosingStock.model.js";
import mongoose from "mongoose";
import { scheduleDailyClosingStockAlert } from "../services/stockWhatsappAlert.service.js";

const isSuperAdminUser = (user) => {
  const role = String(user?.role || "").toUpperCase().trim();
  const jobTitle = String(user?.jobTitle || "").toUpperCase().trim();
  return (
    role === "SUPER_ADMIN" ||
    role === "SUPERADMIN" ||
    jobTitle === "SUPER_ADMIN" ||
    jobTitle === "SUPERADMIN"
  );
};

const isRamAgriMasterUser = (user) => {
  const role = String(user?.role || "").toUpperCase().trim();
  const jobTitle = String(user?.jobTitle || "").toUpperCase().trim();
  return role === "RAM_AGRI_MASTER" || jobTitle === "RAM_AGRI_MASTER";
};

export const canManageRamAgriClosingStock = (user) =>
  isSuperAdminUser(user) || isRamAgriMasterUser(user);

const normalizeStockDate = (raw) => {
  const s = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
};

const todayIstDateString = () => {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
};

/** GET — all varieties with closing stock for a date (+ live current stock). */
export const getRamAgriDailyClosingStock = catchAsync(async (req, res) => {
  const stockDate = normalizeStockDate(req.query.date) || todayIstDateString();

  const crops = await RamAgriInputsProduct.find({ isActive: { $ne: false } })
    .populate("varieties.primaryUnit", "name abbreviation")
    .populate("varieties.secondaryUnit", "name abbreviation")
    .lean();

  const savedRows = await RamAgriDailyClosingStock.find({ stockDate })
    .populate("recordedBy", "name")
    .lean();

  const savedMap = new Map(
    savedRows.map((r) => [`${String(r.cropId)}_${String(r.varietyId)}`, r])
  );

  const items = [];
  for (const crop of crops) {
    for (const variety of crop.varieties || []) {
      if (variety.isActive === false) continue;
      const key = `${String(crop._id)}_${String(variety._id)}`;
      const saved = savedMap.get(key);
      const unit =
        variety.primaryUnit?.abbreviation ||
        variety.primaryUnit?.name ||
        "";
      items.push({
        cropId: crop._id,
        varietyId: variety._id,
        cropName: crop.cropName,
        varietyName: variety.name,
        productType: crop.productType || "seed",
        currentStock: Number(variety.currentStock) || 0,
        closingStock: saved ? Number(saved.closingStock) : null,
        systemStockAtSave: saved ? Number(saved.systemStockAtSave) : null,
        primaryUnit: variety.primaryUnit,
        primaryUnitLabel: unit,
        notes: saved?.notes || "",
        recordedAt: saved?.updatedAt || saved?.createdAt || null,
        recordedBy: saved?.recordedBy || null,
        closingStockId: saved?._id || null,
      });
    }
  }

  items.sort((a, b) => {
    const c = String(a.cropName || "").localeCompare(String(b.cropName || ""));
    if (c !== 0) return c;
    return String(a.varietyName || "").localeCompare(String(b.varietyName || ""));
  });

  const response = generateResponse("Success", "Daily closing stock loaded", {
    stockDate,
    items,
    savedCount: savedRows.length,
    totalVarieties: items.length,
  });
  return res.status(200).json(response);
});

/** POST — bulk upsert closing stock for one date. */
export const upsertRamAgriDailyClosingStock = catchAsync(async (req, res, next) => {
  if (!canManageRamAgriClosingStock(req.user)) {
    return next(
      new AppError("Only Ram Agri Master or Super Admin can save daily closing stock", 403)
    );
  }

  const stockDate = normalizeStockDate(req.body?.stockDate || req.body?.date);
  if (!stockDate) {
    return next(new AppError("stockDate is required (YYYY-MM-DD)", 400));
  }

  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  if (!entries.length) {
    return next(new AppError("entries array is required", 400));
  }

  const crops = await RamAgriInputsProduct.find({ isActive: { $ne: false } })
    .populate("varieties.primaryUnit", "name abbreviation")
    .lean();

  const varietyMeta = new Map();
  for (const crop of crops) {
    for (const variety of crop.varieties || []) {
      varietyMeta.set(`${String(crop._id)}_${String(variety._id)}`, {
        crop,
        variety,
      });
    }
  }

  let upserted = 0;
  const errors = [];
  const alertEntries = [];

  for (const entry of entries) {
    const cropId = entry?.cropId;
    const varietyId = entry?.varietyId;
    if (!cropId || !varietyId) {
      errors.push("Missing cropId or varietyId in entry");
      continue;
    }
    if (!mongoose.isValidObjectId(cropId) || !mongoose.isValidObjectId(varietyId)) {
      errors.push(`Invalid ids: ${cropId}/${varietyId}`);
      continue;
    }

    const closingStock = Number(entry.closingStock);
    if (!Number.isFinite(closingStock) || closingStock < 0) {
      errors.push(`Invalid closing stock for ${cropId}/${varietyId}`);
      continue;
    }

    const meta = varietyMeta.get(`${String(cropId)}_${String(varietyId)}`);
    if (!meta) {
      errors.push(`Variety not found: ${cropId}/${varietyId}`);
      continue;
    }

    const { crop, variety } = meta;
    const unit =
      variety.primaryUnit?.abbreviation ||
      variety.primaryUnit?.name ||
      "";

    await RamAgriDailyClosingStock.findOneAndUpdate(
      { stockDate, cropId, varietyId },
      {
        stockDate,
        cropId,
        varietyId,
        cropName: crop.cropName,
        varietyName: variety.name,
        productType: crop.productType || "seed",
        closingStock,
        systemStockAtSave: Number(variety.currentStock) || 0,
        primaryUnitLabel: unit,
        notes: String(entry.notes || "").trim(),
        recordedBy: req.user._id,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    alertEntries.push({
      cropName: crop.cropName,
      varietyName: variety.name,
      closingStock,
      systemStock: Number(variety.currentStock) || 0,
      unit,
      notes: String(entry.notes || "").trim(),
    });
    upserted += 1;
  }

  if (upserted > 0) {
    scheduleDailyClosingStockAlert({
      stockDate,
      entries: alertEntries,
      performedByName: req.user?.name || "System",
    });
  }

  if (!upserted && errors.length) {
    return next(new AppError(errors[0], 400));
  }

  const response = generateResponse("Success", "Daily closing stock saved", {
    stockDate,
    upserted,
    errors: errors.length ? errors : undefined,
  });
  return res.status(200).json(response);
});
