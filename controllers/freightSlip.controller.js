import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import Dispatch from "../models/dispatch.model.js";
import FreightSlip from "../models/freightSlip.model.js";
import FreightRateCard from "../models/freightRateCard.model.js";
import { quoteFreight, dominantCrop } from "../utility/freightQuote.js";
import {
  buildPrefill,
  saveTentative,
  finalizeSlip,
  tripStatusOf,
  slipSummary,
  TRIP_STATUS,
  FREIGHT_FINALIZE_ROLES,
} from "../services/freightSlip.service.js";
import { htmlToPdfBuffer } from "../services/htmlToPdf.service.js";
import { renderFreightSlipDocument } from "../../shared/dispatch-documents/index.js";

const ok = (res, message, data, code = 200) =>
  res.status(code).json(generateResponse("Success", message, data, undefined));

const sourceOf = (req) => (String(req.body?.source || req.query?.source || "").toUpperCase() === "APP" ? "APP" : "WEB");

const DISPATCH_POPULATE = {
  path: "orderIds",
  select: "orderId numberOfPlants farmer",
  populate: { path: "farmer", select: "name village" },
};

function dispatchCard(d, slip) {
  const prefill = buildPrefill(d);
  const loadSummary = slip?.loadSummary?.length ? slip.loadSummary : prefill.loadSummary;
  const villages = slip?.villages?.length ? slip.villages : prefill.villages;
  const totalPlants = loadSummary.reduce((s, l) => s + (Number(l.plants) || 0), 0);
  const totalCrates = loadSummary.reduce((s, l) => s + (Number(l.crates) || 0), 0);
  return {
    dispatchId: d._id,
    transportId: d.transportId,
    name: d.name || "",
    createdAt: d.createdAt,
    transportStatus: d.transportStatus || "PENDING",
    vehicleName: d.vehicleName || "",
    vehicleNumber: d.vehicleNumber || "",
    driverName: d.driverName || "",
    driverMobile: d.driverMobile || "",
    villages,
    loadSummary,
    totalPlants,
    totalCrates,
    tripStatus: tripStatusOf(slip),
    slip: slip || null,
  };
}

/**
 * Trips for the travel manager app.
 * GET /api/v1/freight-slips/trips?status=SLIP_PENDING|VEHICLE_OUT|COMPLETED&days=30&search=
 */
export const listTrips = catchAsync(async (req, res) => {
  const days = Math.min(120, Math.max(1, parseInt(req.query.days, 10) || 30));
  const status = String(req.query.status || "").trim().toUpperCase();
  const search = String(req.query.search || "").trim();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const base = {
    isDeleted: { $ne: true },
    isInstantPickup: { $ne: true },
    transportStatus: { $ne: "CANCELLED" },
  };
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    base.$or = [{ transportId: rx }, { vehicleNumber: rx }, { vehicleName: rx }, { driverName: rx }];
  }

  // Open (tentative) slips stay listed even if older than the window.
  const openSlipDispatchIds = await FreightSlip.find({ status: "TENTATIVE" }).distinct("dispatchId");
  const windowFilter = { ...base, $and: [{ $or: [{ createdAt: { $gte: since } }, { _id: { $in: openSlipDispatchIds } }] }] };

  const rows = await Dispatch.find(windowFilter)
    .sort({ createdAt: -1 })
    .limit(200)
    .populate(DISPATCH_POPULATE)
    .lean();
  const slips = await FreightSlip.find({ dispatchId: { $in: rows.map((r) => r._id) } }).lean();
  const slipByDispatch = new Map(slips.map((s) => [String(s.dispatchId), s]));

  const all = rows.map((d) => dispatchCard(d, slipByDispatch.get(String(d._id))));
  const counts = {
    all: all.length,
    [TRIP_STATUS.SLIP_PENDING]: all.filter((t) => t.tripStatus === TRIP_STATUS.SLIP_PENDING).length,
    [TRIP_STATUS.VEHICLE_OUT]: all.filter((t) => t.tripStatus === TRIP_STATUS.VEHICLE_OUT).length,
    [TRIP_STATUS.COMPLETED]: all.filter((t) => t.tripStatus === TRIP_STATUS.COMPLETED).length,
  };
  const data = status && TRIP_STATUS[status] ? all.filter((t) => t.tripStatus === status) : all;

  return ok(res, "Trips fetched", { data, counts, canFinalize: canFinalize(req.user) });
});

function canFinalize(user) {
  return [user?.role, user?.jobTitle].filter(Boolean).some((r) => FREIGHT_FINALIZE_ROLES.includes(r));
}

/** GET /api/v1/freight-slips/dispatch/:dispatchId — slip (or null) plus prefill for the form. */
export const getSlipForDispatch = catchAsync(async (req, res, next) => {
  const { dispatchId } = req.params;
  if (!mongoose.isValidObjectId(dispatchId)) return next(new AppError("Invalid dispatch id", 400));
  const d = await Dispatch.findOne({ _id: dispatchId, isDeleted: { $ne: true } }).populate(DISPATCH_POPULATE).lean();
  if (!d) return next(new AppError("Dispatch not found", 404));
  const slip = await FreightSlip.findOne({ dispatchId: d._id }).lean();
  return ok(res, "Freight slip fetched", { ...dispatchCard(d, slip), canFinalize: canFinalize(req.user) });
});

/**
 * Live rate preview.
 * GET /api/v1/freight-slips/quote?rateCardId&loadType&crop&crates&km[&dispatchId]
 */
export const getQuote = catchAsync(async (req, res, next) => {
  const { rateCardId, loadType, km, dispatchId } = req.query;
  let { crop, crates } = req.query;
  if (!rateCardId || !mongoose.isValidObjectId(String(rateCardId))) {
    return next(new AppError("Select a vehicle rate card", 400));
  }
  const card = await FreightRateCard.findById(rateCardId).lean();
  if (!card) return next(new AppError("Vehicle rate card not found", 404));

  if ((!crop || crates == null || crates === "") && dispatchId && mongoose.isValidObjectId(String(dispatchId))) {
    const d = await Dispatch.findById(dispatchId).select("plantsDetails").lean();
    const dom = dominantCrop(buildPrefill(d || {}).loadSummary);
    crop = crop || dom.crop;
    if (crates == null || crates === "") crates = dom.totalCrates;
  }
  const quote = quoteFreight(card, { loadTypeName: loadType, crop, crates, km });
  return ok(res, quote.ok ? "Quote ready" : quote.message, {
    ...quote,
    crop: crop || "",
    crates: Number(crates) || 0,
    rateCardId: card._id,
    rateCardName: card.name,
    loadTypes: (card.loadTypes || []).map((l) => l.name),
  });
});

/** PUT /api/v1/freight-slips/dispatch/:dispatchId/tentative */
export const putTentative = catchAsync(async (req, res) => {
  const slip = await saveTentative({
    dispatchId: req.params.dispatchId,
    input: req.body || {},
    user: req.user,
    source: sourceOf(req),
  });
  return ok(res, "Tentative freight slip saved", slip);
});

/** POST /api/v1/freight-slips/dispatch/:dispatchId/finalize */
export const postFinalize = catchAsync(async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const slip = await finalizeSlip({
      dispatchId: req.params.dispatchId,
      input: req.body || {},
      user: req.user,
      source: "APP",
      session,
    });
    await session.commitTransaction();
    return ok(res, slip.finalUnchanged ? "Freight slip finalized (no change)" : "Freight slip finalized", slip);
  } catch (err) {
    await session.abortTransaction();
    return next(err);
  } finally {
    session.endSession();
  }
});

/** GET /api/v1/freight-slips/dispatch/:dispatchId/pdf?stage=tentative|final — 80mm PDF bytes. */
export const getSlipPdf = catchAsync(async (req, res, next) => {
  const { dispatchId } = req.params;
  if (!mongoose.isValidObjectId(dispatchId)) return next(new AppError("Invalid dispatch id", 400));
  const slip = await FreightSlip.findOne({ dispatchId }).lean();
  if (!slip) return next(new AppError("Freight slip not found", 404));
  const stage = String(req.query.stage || "").toLowerCase() === "tentative" ? "tentative" : slip.final ? "final" : "tentative";
  const html = renderFreightSlipDocument(slip, { stage });
  const buf = await htmlToPdfBuffer(html, { width: "80mm", fitContentHeight: true });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${slip.slipNumber}-${stage}.pdf"`);
  return res.status(200).send(buf);
});
