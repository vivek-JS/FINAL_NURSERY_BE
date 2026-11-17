import mongoose from "mongoose";
import AppError from "../utility/appError.js";
import Dispatch from "../models/dispatch.model.js";
import FreightSlip, { FREIGHT_COMPARE_FIELDS } from "../models/freightSlip.model.js";
import FreightRateCard from "../models/freightRateCard.model.js";
import Trip from "../models/trip.model.js";
import { allocateTripNumber } from "../utility/tripNumber.js";
import { quoteFreight, dominantCrop, round2, extraKmForOrders, EXTRA_KM_PER_ORDER } from "../utility/freightQuote.js";
import { ensureDriverPayment } from "./driverPayment.service.js";

/**
 * Roles allowed to finalize a freight slip (travel manager).
 * TODO(travel-manager): add the dedicated travel manager role here once it is decided.
 */
export const FREIGHT_FINALIZE_ROLES = [
  "DISPATCH_MANAGER",
  "SUPER_ADMIN",
  "SUPERADMIN",
  "ADMIN",
  "OFFICE_ADMIN",
];

export function userCanManageTrips(user) {
  if (user?.canManageTrips === true) return true;
  return [user?.role, user?.jobTitle].filter(Boolean).some((r) => FREIGHT_FINALIZE_ROLES.includes(r));
}

export const TRIP_STATUS = {
  SLIP_PENDING: "SLIP_PENDING",
  VEHICLE_OUT: "VEHICLE_OUT",
  COMPLETED: "COMPLETED",
};

const withSession = (q, session) => (session ? q.session(session) : q);

/** IST day+month+yy unpadded: 1 Jan 2026 → 1126. */
export function dateSlipBase(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "numeric",
    year: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("day")}${get("month")}${get("year")}`;
}

export function istDayStart(date = new Date()) {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return new Date(`${ymd}T00:00:00+05:30`);
}

async function allocateSlipNumber(when, session) {
  const base = dateSlipBase(when);
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rows = await withSession(
    FreightSlip.find({ slipNumber: new RegExp(`^${escaped}(-\\d+)?$`) }).select("slipNumber"),
    session
  ).lean();
  const used = new Set(rows.map((r) => r.slipNumber));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

const toMoney = (v, field) => {
  if (v === null || v === undefined || String(v).trim() === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new AppError(`${field} must be a number ≥ 0`, 400);
  return round2(n);
};

function isLocalMarket(input) {
  const v = input?.localMarket;
  return v === true || v === 1 || v === "1" || String(v || "").toLowerCase() === "true";
}

function plantsFromLoad(loadSummary = []) {
  return (loadSummary || []).reduce((s, l) => s + (Number(l.plants) || 0), 0);
}

function orderCountOf(dispatch) {
  return Array.isArray(dispatch?.orderIds) ? dispatch.orderIds.length : 0;
}

const userName = (u) => u?.name || [u?.firstName, u?.lastName].filter(Boolean).join(" ") || u?.phoneNumber || "";

const DISPATCH_POPULATE = {
  path: "orderIds",
  select: "orderId numberOfPlants farmer",
  populate: { path: "farmer", select: "name village" },
};

/** Villages (from each order's farmer) and crop/crate summary (from plantsDetails). */
export function buildPrefill(dispatch) {
  const qtyByOrder = new Map(
    (dispatch?.orderDispatchDetails || []).map((od) => [String(od.orderId), Number(od.dispatchQuantity) || 0])
  );
  const villageMap = new Map();
  for (const o of dispatch?.orderIds || []) {
    const name = String(o?.farmer?.village || "").trim();
    if (!name) continue;
    const plants = qtyByOrder.get(String(o._id)) ?? (Number(o.numberOfPlants) || 0);
    const key = name.toLowerCase();
    const prev = villageMap.get(key);
    if (prev) prev.plants += plants;
    else villageMap.set(key, { name, plants });
  }
  const villages = [...villageMap.values()].map((v, i) => ({ ...v, seq: i + 1 }));

  const cropMap = new Map();
  for (const p of dispatch?.plantsDetails || []) {
    const crop = String(p?.name || "").trim() || "Plants";
    const plants = Number(p?.totalPlants ?? p?.quantity) || 0;
    const crates = (p?.crates || []).reduce((s, c) => s + (Number(c?.crateCount) || 0), 0);
    const key = crop.toLowerCase();
    const prev = cropMap.get(key);
    if (prev) {
      prev.plants += plants;
      prev.crates += crates;
    } else cropMap.set(key, { crop, plants, crates });
  }
  const loadSummary = [...cropMap.values()];
  return { villages, loadSummary };
}

function normalizeVillages(raw) {
  if (!Array.isArray(raw)) return null;
  return raw
    .map((v, i) => ({
      name: String(v?.name || "").trim(),
      plants: Math.max(0, Number(v?.plants) || 0),
      seq: i + 1,
    }))
    .filter((v) => v.name);
}

/** Recomputes the rate from the CMS rate card; the client can't set ratePerKm or amounts. */
export async function computeEntry(input, { loadSummary, orderCount = 0, user, source, session }) {
  const localMarket = isLocalMarket(input);
  const km = Number(input?.km);
  if (!localMarket && (!Number.isFinite(km) || km <= 0)) {
    throw new AppError("Tentative distance (KM) is required", 400);
  }
  const rateCardId = input?.rateCardId;
  if (!rateCardId || !mongoose.isValidObjectId(String(rateCardId))) {
    throw new AppError("Select a vehicle rate card", 400);
  }
  const card = await withSession(FreightRateCard.findById(rateCardId).lean(), session);
  if (!card) throw new AppError("Vehicle rate card not found", 404);

  const dom = dominantCrop(loadSummary);
  const crop = String(input?.crop || "").trim() || dom.crop;
  const crates =
    input?.crates != null && String(input.crates).trim() !== "" ? Number(input.crates) : dom.totalCrates;
  const plants = plantsFromLoad(loadSummary);
  const extraKm = extraKmForOrders(orderCount, { localMarket });
  const runKm = Number.isFinite(km) && km > 0 ? round2(km) : 0;
  const billedKm = localMarket ? runKm : round2(runKm + extraKm);

  const quote = quoteFreight(card, {
    loadTypeName: input?.loadType,
    crop,
    crates,
    km: billedKm,
    localMarket,
    plants,
  });
  if (!quote.ok) throw new AppError(quote.message, 400);

  const freightAmount = round2(quote.amount ?? (localMarket ? 0 : billedKm * (quote.ratePerKm || 0)));
  const otherAmount = toMoney(input?.otherAmount, "Other amount");

  return {
    km: runKm,
    extraKm,
    extraKmPerOrder: EXTRA_KM_PER_ORDER,
    orderCount: Math.max(0, Math.round(Number(orderCount) || 0)),
    billedKm,
    localMarket,
    plants,
    ratePerPlant: Number(quote.ratePerPlant) || 0,
    rateCardId: card._id,
    rateCardName: card.name,
    loadType: localMarket ? "Local" : quote.loadTypeName || "",
    crop,
    crates: Number.isFinite(crates) ? crates : 0,
    ratePerKm: quote.ratePerKm || 0,
    rateMode: quote.mode,
    rateNote: quote.message || "",
    freightAmount,
    bhatta: 0,
    bhattas: [],
    otherAmount,
    totalAmount: round2(freightAmount + otherAmount),
    remarks: String(input?.remarks || "").trim(),
    source,
    by: user?._id || null,
    byName: userName(user),
    at: new Date(),
  };
}

const cmpValue = (field, v) => {
  if (field === "rateCardId") return v ? String(v) : "";
  if (field === "localMarket") return v === true || v === "true" || v === 1 || v === "1" ? "1" : "0";
  if (field === "remarks" || field === "loadType" || field === "crop") return String(v || "").trim().toLowerCase();
  if (field === "bhattas") {
    const rows = Array.isArray(v) ? v : [];
    return rows
      .map((b) => `${String(b?.name || "").trim().toLowerCase()}:${round2(Number(b?.amount) || 0)}`)
      .join("|");
  }
  return round2(Number(v) || 0);
};

export function diffEntries(a, b) {
  return FREIGHT_COMPARE_FIELDS.filter((f) => cmpValue(f, a?.[f]) !== cmpValue(f, b?.[f]));
}

async function loadDispatch(dispatchId, session) {
  if (!mongoose.isValidObjectId(String(dispatchId))) throw new AppError("Invalid dispatch id", 400);
  const dispatch = await withSession(
    Dispatch.findOne({ _id: dispatchId, isDeleted: { $ne: true } }).populate(DISPATCH_POPULATE),
    session
  ).lean();
  if (!dispatch) throw new AppError("Dispatch not found", 404);
  if (dispatch.transportStatus === "CANCELLED") throw new AppError("Dispatch is cancelled", 400);
  return dispatch;
}

/** Create or update the tentative entry. Refused once the slip is FINAL. */
export async function saveTentative({ dispatchId, input, user, source = "WEB", session = null }) {
  const dispatch = await loadDispatch(dispatchId, session);
  const existing = await withSession(FreightSlip.findOne({ dispatchId: dispatch._id }), session);
  if (existing?.status === "FINAL") throw new AppError("Freight slip is already final", 400);

  const prefill = buildPrefill(dispatch);
  const loadSummary = existing?.loadSummary?.length ? existing.loadSummary : prefill.loadSummary;
  const villages = normalizeVillages(input?.villages) ?? (existing?.villages?.length ? existing.villages : prefill.villages);
  const entry = await computeEntry(input, {
    loadSummary,
    orderCount: orderCountOf(dispatch),
    user,
    source,
    session,
  });

  const snapshot = {
    transportId: dispatch.transportId,
    vehicleName: dispatch.vehicleName || "",
    vehicleNumber: dispatch.vehicleNumber || "",
    driverName: dispatch.driverName || "",
    driverMobile: dispatch.driverMobile || "",
    villages,
    loadSummary,
    tentative: entry,
  };
  const historyRow = {
    action: existing ? "TENTATIVE_UPDATED" : "TENTATIVE_CREATED",
    source,
    by: entry.by,
    byName: entry.byName,
    at: entry.at,
    totalAmount: entry.totalAmount,
  };

  let slip;
  if (existing) {
    existing.set(snapshot);
    existing.history.push(historyRow);
    slip = await existing.save({ session });
  } else {
    const when = dispatch.createdAt ? new Date(dispatch.createdAt) : new Date();
    const slipNumber = await allocateSlipNumber(when, session);
    [slip] = await FreightSlip.create(
      [
        {
          ...snapshot,
          dispatchId: dispatch._id,
          slipNumber,
          slipDate: istDayStart(when),
          status: "TENTATIVE",
          history: [historyRow],
        },
      ],
      { session }
    );
    await Dispatch.updateOne({ _id: dispatch._id }, { $set: { freightSlipId: slip._id } }, { session });
  }
  return slip.toObject();
}

/** Upsert the dispatch's Trip from the final entry (same shape handleDispatchReturns writes). */
async function syncTripFromFinal(dispatch, final, user, session) {
  const tripSet = {
    vehicleId: dispatch.vehicleId || undefined,
    vehicleName: dispatch.vehicleName || "",
    vehicleNumber: dispatch.vehicleNumber || "",
    driverName: dispatch.driverName || "",
    driverContact: dispatch.driverMobile || "",
    dispatchId: dispatch._id,
    orderIds: (dispatch.orderIds || []).map((o) => o._id || o),
    kmRun: final.km,
    rent: final.freightAmount,
    otherCharges: round2((final.bhatta || 0) + (final.otherAmount || 0)),
    status: "delivered",
    endDate: new Date(),
    completedBy: user?._id || undefined,
  };
  if (final.remarks) tripSet.tripRemark = final.remarks;

  const existingTrip = await withSession(Trip.findOne({ dispatchId: dispatch._id }).select("tripNumber"), session);
  const tripNumber = existingTrip?.tripNumber || (await allocateTripNumber(Trip, { transportId: dispatch.transportId }));
  const trip = await Trip.findOneAndUpdate(
    { dispatchId: dispatch._id },
    { $set: tripSet, $setOnInsert: { tripNumber } },
    { new: true, upsert: true, session, setDefaultsOnInsert: true }
  );
  if (String(dispatch.tripId || "") !== String(trip._id)) {
    await Dispatch.updateOne({ _id: dispatch._id }, { $set: { tripId: trip._id } }, { session });
  }
  return trip;
}

/**
 * Final entry by the travel manager. Missing fields fall back to the tentative values,
 * so an empty body confirms the tentative slip as final.
 */
export async function finalizeSlip({ dispatchId, input = {}, user, source = "APP", session = null }) {
  const dispatch = await loadDispatch(dispatchId, session);
  const slip = await withSession(FreightSlip.findOne({ dispatchId: dispatch._id }), session);
  if (!slip) throw new AppError("Create the tentative freight slip first", 400);
  if (slip.status === "FINAL") throw new AppError("Freight slip is already final", 400);

  const t = slip.tentative.toObject ? slip.tentative.toObject() : slip.tentative;
  const pick = (k) => (input[k] !== undefined && input[k] !== null && String(input[k]) !== "" ? input[k] : t[k]);
  const merged = {
    km: pick("km"),
    rateCardId: pick("rateCardId"),
    loadType: pick("loadType"),
    crop: pick("crop"),
    crates: pick("crates"),
    localMarket: input.localMarket !== undefined && input.localMarket !== null ? input.localMarket : t.localMarket,
    otherAmount: input.otherAmount !== undefined && input.otherAmount !== null ? input.otherAmount : t.otherAmount,
    remarks: input.remarks !== undefined && input.remarks !== null ? input.remarks : t.remarks,
  };
  // Confirming with no edits keeps the tentative amounts as-is, even if the rate card changed since.
  const hasEdits = [...FREIGHT_COMPARE_FIELDS, "villages", "localMarket"].some(
    (k) => input[k] !== undefined && input[k] !== null
  );
  const final = hasEdits
    ? await computeEntry(merged, {
        loadSummary: slip.loadSummary,
        orderCount: orderCountOf(dispatch),
        user,
        source,
        session,
      })
    : {
        ...t,
        _id: undefined,
        source,
        by: user?._id || null,
        byName: userName(user),
        at: new Date(),
      };
  const changedFields = hasEdits ? diffEntries(t, final) : [];

  const villages = normalizeVillages(input.villages);
  if (villages) {
    const names = (list) => list.map((v) => String(v.name).trim().toLowerCase()).join("|");
    if (names(villages) !== names(slip.villages || [])) changedFields.push("villages");
    slip.villages = villages;
  }
  slip.final = final;
  slip.status = "FINAL";
  slip.finalUnchanged = changedFields.length === 0;
  slip.changedFields = changedFields;
  slip.history.push({
    action: "FINALIZED",
    source,
    by: final.by,
    byName: final.byName,
    at: final.at,
    totalAmount: final.totalAmount,
    changedFields,
  });
  await slip.save({ session });
  await syncTripFromFinal(dispatch, final, user, session);
  const saved = slip.toObject();
  await ensureDriverPayment({ dispatchId: dispatch._id, dispatch, slip: saved, user, session });
  return saved;
}

export function tripStatusOf(slip) {
  if (!slip) return TRIP_STATUS.SLIP_PENDING;
  return slip.status === "FINAL" ? TRIP_STATUS.COMPLETED : TRIP_STATUS.VEHICLE_OUT;
}

/** Compact slip summary for list rows (fleet ledger, trips list). */
export function slipSummary(slip) {
  if (!slip) return null;
  return {
    _id: slip._id,
    slipNumber: String(slip.slipNumber || "").replace(/^FS-/i, "") || slip.slipNumber,
    status: slip.status,
    tentativeTotal: slip.tentative?.totalAmount ?? null,
    tentativeKm: slip.tentative?.km ?? null,
    finalTotal: slip.final?.totalAmount ?? null,
    finalKm: slip.final?.km ?? null,
    finalUnchanged: slip.finalUnchanged,
    changedFields: slip.changedFields || [],
  };
}
