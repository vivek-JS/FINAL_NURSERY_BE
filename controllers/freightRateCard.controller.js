import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import FreightRateCard, { FREIGHT_SLAB_CONDITIONS } from "../models/freightRateCard.model.js";
import { DEFAULT_FREIGHT_RATE_CARDS } from "../utility/freightRateDefaults.js";

const normalizeCode = (c) =>
  String(c || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const toNum = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};

function normalizeSlab(raw, where) {
  const crop = String(raw?.crop || "").trim();
  if (!crop) throw new AppError(`${where}: crop is required`, 400);
  const condition = String(raw?.condition || "").trim().toUpperCase();
  if (!FREIGHT_SLAB_CONDITIONS.includes(condition)) {
    throw new AppError(`${where}: condition must be one of ${FREIGHT_SLAB_CONDITIONS.join(", ")}`, 400);
  }
  const ratePerKm = toNum(raw?.ratePerKm);
  if (ratePerKm == null || Number.isNaN(ratePerKm) || ratePerKm < 0) {
    throw new AppError(`${where}: rate per km must be a number ≥ 0`, 400);
  }
  const slab = { crop, condition, ratePerKm, value: null, from: null, to: null };
  if (raw?._id && mongoose.isValidObjectId(raw._id)) slab._id = raw._id;
  if (condition === "BETWEEN") {
    const from = toNum(raw?.from);
    const to = toNum(raw?.to);
    if (from == null || to == null || Number.isNaN(from) || Number.isNaN(to) || from < 0 || to < from) {
      throw new AppError(`${where}: crates "from" and "to" are required and "to" must be ≥ "from"`, 400);
    }
    slab.from = from;
    slab.to = to;
  } else {
    const value = toNum(raw?.value);
    if (value == null || Number.isNaN(value) || value < 0) {
      throw new AppError(`${where}: crates value is required`, 400);
    }
    slab.value = value;
  }
  return slab;
}

function normalizeCardBody(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || "").trim();
    if (!name) throw new AppError("Vehicle name is required", 400);
    out.name = name;
  }
  if (!partial || body.code !== undefined || body.name !== undefined) {
    const code = normalizeCode(body.code || body.name);
    if (!code) throw new AppError("Vehicle code is required", 400);
    out.code = code;
  }
  if (body.sortOrder !== undefined) out.sortOrder = Number(body.sortOrder) || 0;
  if (body.isActive !== undefined) out.isActive = Boolean(body.isActive);
  if (body.notes !== undefined) out.notes = String(body.notes || "").trim();
  if (body.localMarketRatePerPlant !== undefined) {
    const v = toNum(body.localMarketRatePerPlant);
    if (Number.isNaN(v) || (v != null && v < 0)) throw new AppError("Local market rate must be ≥ 0", 400);
    out.localMarketRatePerPlant = v ?? 0;
  }
  if (body.shortTripMaxKm !== undefined || body.shortTripRatePerKm !== undefined) {
    const km = toNum(body.shortTripMaxKm);
    const rate = toNum(body.shortTripRatePerKm);
    if (Number.isNaN(km) || Number.isNaN(rate)) throw new AppError("Short trip values must be numbers", 400);
    if ((km == null) !== (rate == null)) {
      throw new AppError("Short trip needs both distance (km) and rate per km, or neither", 400);
    }
    out.shortTripMaxKm = km;
    out.shortTripRatePerKm = rate;
  }
  if (body.loadTypes !== undefined) {
    if (!Array.isArray(body.loadTypes)) throw new AppError("loadTypes must be an array", 400);
    const seen = new Set();
    out.loadTypes = body.loadTypes.map((lt, i) => {
      const name = String(lt?.name || "").trim();
      if (!name) throw new AppError(`Load type ${i + 1}: name is required`, 400);
      const key = name.toLowerCase();
      if (seen.has(key)) throw new AppError(`Load type "${name}" is listed twice`, 400);
      seen.add(key);
      const slabs = Array.isArray(lt?.slabs) ? lt.slabs : [];
      const doc = {
        name,
        sortOrder: lt?.sortOrder != null ? Number(lt.sortOrder) || 0 : i + 1,
        slabs: slabs.map((s, j) => normalizeSlab(s, `${name} · slab ${j + 1}`)),
      };
      if (lt?._id && mongoose.isValidObjectId(lt._id)) doc._id = lt._id;
      return doc;
    });
  }
  return out;
}

async function insertMissingDefaults(userId) {
  const existing = await FreightRateCard.find({}, { code: 1 }).lean();
  const codes = new Set(existing.map((e) => e.code));
  const missing = DEFAULT_FREIGHT_RATE_CARDS.filter((c) => !codes.has(c.code));
  if (!missing.length) return 0;
  await FreightRateCard.insertMany(missing.map((c) => ({ ...c, updatedBy: userId || null })), {
    ordered: false,
  }).catch((e) => {
    if (e?.code !== 11000) throw e;
  });
  return missing.length;
}

export const listFreightRateCards = catchAsync(async (req, res) => {
  if ((await FreightRateCard.estimatedDocumentCount()) === 0) {
    await insertMissingDefaults(req.user?._id);
  }
  const activeOnly = ["true", "1"].includes(String(req.query.activeOnly || ""));
  const rows = await FreightRateCard.find(activeOnly ? { isActive: true } : {})
    .sort({ sortOrder: 1, name: 1 })
    .populate("updatedBy", "name")
    .lean();
  return res.status(200).json(generateResponse("Success", "Freight rate cards loaded", rows, undefined));
});

export const createFreightRateCard = catchAsync(async (req, res, next) => {
  const data = normalizeCardBody(req.body || {});
  if (await FreightRateCard.exists({ code: data.code })) {
    return next(new AppError(`A vehicle with code ${data.code} already exists`, 400));
  }
  const doc = await FreightRateCard.create({
    localMarketRatePerPlant: 0.5,
    ...data,
    isActive: data.isActive ?? true,
    updatedBy: req.user?._id || null,
  });
  return res.status(201).json(generateResponse("Success", "Vehicle rate card created", doc, undefined));
});

export const updateFreightRateCard = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return next(new AppError("Invalid id", 400));
  const data = normalizeCardBody(req.body || {}, { partial: true });
  if (data.code && (await FreightRateCard.exists({ code: data.code, _id: { $ne: id } }))) {
    return next(new AppError(`A vehicle with code ${data.code} already exists`, 400));
  }
  data.updatedBy = req.user?._id || null;
  const doc = await FreightRateCard.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  if (!doc) return next(new AppError("Vehicle rate card not found", 404));
  return res.status(200).json(generateResponse("Success", "Vehicle rate card updated", doc, undefined));
});

export const deleteFreightRateCard = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return next(new AppError("Invalid id", 400));
  const doc = await FreightRateCard.findByIdAndDelete(id);
  if (!doc) return next(new AppError("Vehicle rate card not found", 404));
  return res.status(200).json(generateResponse("Success", "Vehicle rate card deleted", doc, undefined));
});

export const restoreDefaultFreightRateCards = catchAsync(async (req, res) => {
  const added = await insertMissingDefaults(req.user?._id);
  return res
    .status(200)
    .json(
      generateResponse(
        "Success",
        added ? `${added} default vehicle card(s) added` : "All default vehicle cards already exist",
        { added },
        undefined
      )
    );
});
