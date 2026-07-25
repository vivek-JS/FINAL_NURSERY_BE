import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import APIFeatures from "../utility/apiFeatures.js";
import Tray from "../models/tray.model.js";
import mongoose from "mongoose";
import moment from "moment";
import PlantOutward from "../models/plantOutward.model.js";
import Sowing from "../models/sowing.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import {
  safeMongooseNumber,
  safeNonNegativeInt,
  safeSubtractNonNegative,
  clampUintForDb,
} from "../utility/safeMongooseNumber.js";
import {
  batchNumericValue,
  buildSowingMatchForBatchList,
  buildSowingMatchForSingleBatch,
} from "../utility/sowingBatchMatch.js";
import {
  collectAcceptedLabPool,
  collectGlobalAcceptedLabPool,
  allocateFifo,
  allocateFifoByBottles,
  fifoAllocationsMatch,
  suggestSizeRows,
  distributeBottlesToSizeRows,
  validateBottlesForInward,
  validateFifoPlantsVsSown,
  getAvailableLabStock,
  computeLabLineStock as computeLabLineStockFifo,
  isLabLineAcceptedForPrimary as isLabAcceptedFifo,
} from "../utility/primaryInwardFifo.js";
import {
  syncSecondaryInwardSlotStockAdd,
  subtractSecondaryInwardSlotStock,
  resolveBookingSlotIdForSecondaryBatch,
  relocateSecondaryInwardSlotOnBypass,
} from "../services/secondaryShedSlotStock.service.js";
import {
  recordSecondaryInwardOnLedger,
  recordSecondaryOutwardOnLedger,
} from "../services/secondaryDispatchAvailability.service.js";
import {
  recordShedActivity,
  buildShedActivityTimeline,
  SHED_ACTIVITY_ACTIONS,
} from "../services/shedActivity.service.js";
import Order from "../models/order.model.js";
import Dispatch from "../models/dispatch.model.js";
import { updateOrderWithLedgerSync } from "./dispatch.controller.js";
import { allocateNextInvoiceNumbers } from "../services/invoiceSequence.service.js";
import { ensureOfficialDeliveryChallanForOrder } from "../services/officialDeliveryChallan.service.js";
import {
  previewSecondaryVehicleLoad,
  executeSecondaryVehicleLoad,
  sumPlantsLoadedOnDispatch,
  groupPolyhouseStockByBatch,
  DISPATCH_SHED_ALLOWED_STATUSES,
  findDispatchActiveByIdOrTransport,
} from "../services/secondaryVehicleLoad.service.js";
import {
  collectLoadedOutwardLinesForDispatch,
  executeSecondaryVehicleUnload,
} from "../services/secondaryVehicleUnload.service.js";
import {
  listSowReadyEntries,
  listSowReadyEntriesForDispatch,
  listAllSowReadyEntriesByDate,
  executeSowReadyVehicleLoad,
  isPlantSowingAllowed,
} from "../services/secondarySowReadyDispatch.service.js";
import PlantCms from "../models/plantCms.model.js";

const BATCH_SELECT_FIELDS =
  "batchNumber dateAdded primaryPlantReadyDays secondaryPlantReadyDays isActive plantCmsId plantSubtypeId";

const BATCH_POPULATE = {
  path: "batchId",
  select: BATCH_SELECT_FIELDS,
  populate: { path: "plantCmsId", select: "name subtypes" },
};

const orderBookablePlantsTotal = (doc) =>
  Number(doc?.numberOfPlants || 0) + Number(doc?.additionalPlants || 0);

const orderRemainingPlantsValue = (doc) => {
  const rem = doc?.remainingPlants;
  if (rem != null && Number.isFinite(Number(rem))) return Number(rem);
  return orderBookablePlantsTotal(doc);
};

const orderMatchesDispatchBatch = (orderDoc, batchLean) => {
  if (!batchLean?.plantCmsId || !batchLean?.plantSubtypeId) return false;
  return (
    String(orderDoc.plantName) === String(batchLean.plantCmsId) &&
    String(orderDoc.plantSubtype) === String(batchLean.plantSubtypeId)
  );
};

const buildSecondaryOrderLinkSnapshot = (orderDoc, batchLean) => {
  let pos = orderDoc.productOrderSnapshot;
  if (pos && typeof pos.toObject === "function") pos = pos.toObject();
  return {
    orderIdNumeric: orderDoc.orderId,
    publicOrderCode: orderDoc.publicOrderCode ?? null,
    batchNumber: batchLean?.batchNumber ?? null,
    plantNameId: orderDoc.plantName,
    plantSubtypeId: orderDoc.plantSubtype,
    productOrderSnapshot: pos || undefined,
    productName: orderDoc.productName,
    productMappingId: orderDoc.productMappingId,
  };
};

/** Human labels for mobile UI (lean batch with populated plantCmsId from buildPlantReadyBundle). */
const plantSubtypeLabelsFromLeanBatch = (b) => {
  if (!b) return { plantLabel: "—", subtypeLabel: "—" };
  const plant = b.plantCmsId;
  const sid = b.plantSubtypeId;
  if (!plant || typeof plant === "string" || !plant.name) {
    return { plantLabel: "—", subtypeLabel: "—" };
  }
  const sub = (plant.subtypes || []).find((s) => String(s._id) === String(sid));
  return {
    plantLabel: plant.name || "—",
    subtypeLabel: sub?.name || "—",
  };
};

/**
 * Secondary dispatch eligibility: calendar rule (secondary inward date + batch.secondaryPlantReadyDays)
 * OR readiness bypass on the secondary inward line.
 */
const computeSecondaryDispatchEligibility = (si, secondaryPlantReadyDays, todayStart) => {
  const days = Number(safeMongooseNumber(secondaryPlantReadyDays)) || 0;
  const rawInward = si?.secondaryInwardDate;
  const inward = rawInward ? moment(rawInward).startOf("day") : null;
  const expectedReadyByCalendar = inward ? inward.clone().add(days, "days") : null;
  const calendarDispatchEligible = Boolean(
    expectedReadyByCalendar && todayStart.isSameOrAfter(expectedReadyByCalendar, "day")
  );
  const bypassAt = si?.readinessBypassAt;
  const bypass = bypassAt != null && moment(bypassAt).isValid();
  const dispatchEligible = calendarDispatchEligible || bypass;
  return {
    expectedReadyByCalendar: expectedReadyByCalendar
      ? expectedReadyByCalendar.toISOString()
      : null,
    calendarDispatchEligible,
    readinessBypassAt: bypassAt ?? null,
    readinessBypassBy: si?.readinessBypassBy ?? null,
    readinessBypassReason: si?.readinessBypassReason ?? "",
    dispatchEligible,
    secondaryPlantReadyDaysUsed: days,
  };
};

/**
 * FIFO-sorted secondary inward candidates for plant CMS + subtype (shared by vehicle allocation + farmer dispatch shade picker).
 */
const collectSecondaryInwardSuggestionsForPlantSubtype = async (plantCmsId, plantSubtypeId) => {
  if (!plantCmsId || !plantSubtypeId) {
    return { suggestions: [], batchDocs: [] };
  }

  const active = { isActive: { $ne: false } };

  /** Strict: CMS plant + subtype (current batches). */
  const strictBatches = await DispatchBatch.find({
    plantCmsId,
    plantSubtypeId,
    ...active,
  })
    .select(BATCH_SELECT_FIELDS)
    .populate("plantCmsId", "name subtypes")
    .lean();

  /**
   * Legacy: subtype set but plantCmsId never backfilled — those rows were invisible to vehicle
   * shed pickup (same G9 stock as strict match). Exclude docs that set plantCmsId to another id.
   */
  const legacySubtypeOnly = await DispatchBatch.find({
    plantSubtypeId,
    ...active,
    $or: [{ plantCmsId: null }, { plantCmsId: { $exists: false } }],
  })
    .select(BATCH_SELECT_FIELDS)
    .populate("plantCmsId", "name subtypes")
    .lean();

  const seen = new Set(strictBatches.map((b) => String(b._id)));
  const batchDocs = [...strictBatches];
  for (const b of legacySubtypeOnly) {
    if (!seen.has(String(b._id))) {
      batchDocs.push(b);
      seen.add(String(b._id));
    }
  }

  const batchIds = batchDocs.map((b) => b._id);
  const batchMap = new Map(batchDocs.map((b) => [String(b._id), b]));

  const pos =
    batchIds.length === 0
      ? []
      : await PlantOutward.find({ batchId: { $in: batchIds } }).lean();

  const todayStart = moment().startOf("day");
  const suggestions = [];

  for (const po of pos) {
    const batchLean = batchMap.get(String(po.batchId));
    if (!batchLean) continue;
    const labels = plantSubtypeLabelsFromLeanBatch(batchLean);
    const secDays = Number(safeMongooseNumber(batchLean.secondaryPlantReadyDays)) || 0;

    for (const si of po.secondaryInward || []) {
      const avail = safeNonNegativeInt(safeMongooseNumber(si.availableQuantity), 0);
      if (avail < 1) continue;
      if ((si.transferStatus ?? "available") === "fully_transferred") continue;

      const siPlain = typeof si.toObject === "function" ? si.toObject() : si;
      const elig = computeSecondaryDispatchEligibility(siPlain, secDays, todayStart);
      const bypassAt = siPlain.readinessBypassAt;
      let readyMoment = null;
      if (bypassAt != null && moment(bypassAt).isValid()) {
        readyMoment = moment(bypassAt).startOf("day");
      } else if (elig.expectedReadyByCalendar) {
        readyMoment = moment(elig.expectedReadyByCalendar).startOf("day");
      } else if (siPlain.secondaryInwardDate) {
        readyMoment = moment(siPlain.secondaryInwardDate).add(secDays, "days").startOf("day");
      } else {
        readyMoment = moment().add(365, "days");
      }

      const sortReady = readyMoment.valueOf();
      const sortInward = moment(siPlain.secondaryInwardDate || 0).valueOf();

      let daysUntilReady = null;
      if (elig.dispatchEligible) {
        daysUntilReady = 0;
      } else if (bypassAt != null && moment(bypassAt).isValid()) {
        daysUntilReady = 0;
      } else if (elig.expectedReadyByCalendar) {
        const readyDay = moment(elig.expectedReadyByCalendar).startOf("day");
        daysUntilReady = Math.max(0, readyDay.diff(todayStart, "days"));
      } else {
        const effectiveReady = moment(readyMoment).startOf("day");
        daysUntilReady = Math.max(0, effectiveReady.diff(todayStart, "days"));
      }

      const storedExpectedReady = siPlain.expectedReadyDate;
      const expectedReadyByCalendar =
        storedExpectedReady && moment(storedExpectedReady).isValid()
          ? moment(storedExpectedReady).startOf("day").toISOString()
          : elig.expectedReadyByCalendar;

      suggestions.push({
        batchId: po.batchId,
        batchNumber: batchLean.batchNumber,
        plantOutwardId: po._id,
        secondaryInwardId: si._id,
        availableQuantity: avail,
        remainingPlants: avail,
        dispatchEligible: elig.dispatchEligible,
        expectedReadyByCalendar,
        expectedReadyDate: storedExpectedReady ?? null,
        secondaryInwardDate: siPlain.secondaryInwardDate,
        plantLabel: labels.plantLabel,
        subtypeLabel: labels.subtypeLabel,
        size: siPlain.size,
        cavity: siPlain.cavity,
        numberOfBottles: siPlain.numberOfBottles,
        numberOfTrays: siPlain.numberOfTrays,
        pollyhouse: String(siPlain.pollyhouse || "").trim(),
        secondaryPlantReadyDays: secDays,
        daysUntilReady,
        sortReady,
        sortInward,
      });
    }
  }

  suggestions.sort((a, b) => {
    if (a.sortReady !== b.sortReady) return a.sortReady - b.sortReady;
    return a.sortInward - b.sortInward;
  });

  const stripped = suggestions.map(({ sortReady, sortInward, ...rest }) => rest);

  return { suggestions: stripped, batchDocs };
};

/**
 * All active-batch secondary inward lines (optional plant/subtype filter).
 */
const collectAllSecondaryInwardStockLines = async (plantCmsId, plantSubtypeId) => {
  if (plantCmsId && plantSubtypeId) {
    const { suggestions } = await collectSecondaryInwardSuggestionsForPlantSubtype(
      plantCmsId,
      plantSubtypeId
    );
    return suggestions;
  }

  const active = { isActive: { $ne: false } };
  const batchDocs = await DispatchBatch.find(active)
    .select(BATCH_SELECT_FIELDS)
    .populate("plantCmsId", "name subtypes")
    .lean();

  const batchIds = batchDocs.map((b) => b._id);
  const batchMap = new Map(batchDocs.map((b) => [String(b._id), b]));
  const pos =
    batchIds.length === 0
      ? []
      : await PlantOutward.find({ batchId: { $in: batchIds } }).lean();

  const todayStart = moment().startOf("day");
  const suggestions = [];

  for (const po of pos) {
    const batchLean = batchMap.get(String(po.batchId));
    if (!batchLean) continue;
    const labels = plantSubtypeLabelsFromLeanBatch(batchLean);
    const secDays = Number(safeMongooseNumber(batchLean.secondaryPlantReadyDays)) || 0;

    for (const si of po.secondaryInward || []) {
      const avail = safeNonNegativeInt(safeMongooseNumber(si.availableQuantity), 0);
      if (avail < 1) continue;
      if ((si.transferStatus ?? "available") === "fully_transferred") continue;

      const siPlain = typeof si.toObject === "function" ? si.toObject() : si;
      const elig = computeSecondaryDispatchEligibility(siPlain, secDays, todayStart);
      const storedExpectedReady = siPlain.expectedReadyDate;
      const expectedReadyByCalendar =
        storedExpectedReady && moment(storedExpectedReady).isValid()
          ? moment(storedExpectedReady).startOf("day").toISOString()
          : elig.expectedReadyByCalendar;

      suggestions.push({
        batchId: po.batchId,
        batchNumber: batchLean.batchNumber,
        plantOutwardId: po._id,
        secondaryInwardId: si._id,
        availableQuantity: avail,
        remainingPlants: avail,
        dispatchEligible: elig.dispatchEligible,
        expectedReadyByCalendar,
        expectedReadyDate: storedExpectedReady ?? null,
        secondaryInwardDate: siPlain.secondaryInwardDate,
        plantLabel: labels.plantLabel,
        subtypeLabel: labels.subtypeLabel,
        plantCmsId: batchLean.plantCmsId,
        plantSubtypeId: batchLean.plantSubtypeId,
        size: siPlain.size,
        cavity: siPlain.cavity,
        numberOfBottles: siPlain.numberOfBottles,
        numberOfTrays: siPlain.numberOfTrays,
        pollyhouse: String(siPlain.pollyhouse || "").trim(),
        secondaryPlantReadyDays: secDays,
        daysUntilReady: elig.dispatchEligible
          ? 0
          : elig.expectedReadyByCalendar
            ? Math.max(
                0,
                moment(elig.expectedReadyByCalendar)
                  .startOf("day")
                  .diff(todayStart, "days")
              )
            : null,
      });
    }
  }

  suggestions.sort((a, b) => {
    const aReady = a.expectedReadyByCalendar
      ? moment(a.expectedReadyByCalendar).valueOf()
      : 0;
    const bReady = b.expectedReadyByCalendar
      ? moment(b.expectedReadyByCalendar).valueOf()
      : 0;
    if (aReady !== bReady) return aReady - bReady;
    return (
      moment(a.secondaryInwardDate || 0).valueOf() -
      moment(b.secondaryInwardDate || 0).valueOf()
    );
  });

  return suggestions;
};

const pollyhouseMatchesFilter = (linePollyhouse, filterPollyhouse) => {
  const ph = String(linePollyhouse || "").trim().toLowerCase();
  const f = String(filterPollyhouse || "").trim().toLowerCase();
  if (!ph || !f) return false;
  return ph === f || ph.includes(f) || f.includes(ph);
};

/** Next 1-based fulfillment sequence for vehicle-linked secondary outwards on this dispatch. */
const computeSuggestedFulfillmentSequence = async (dispatchId) => {
  if (!mongoose.isValidObjectId(String(dispatchId))) return 1;
  const oid = new mongoose.Types.ObjectId(String(dispatchId));
  const pos = await PlantOutward.find({
    "secondaryOutward.linkedDispatchId": oid,
  })
    .select("secondaryOutward.linkedDispatchId secondaryOutward.dispatchFulfillmentSequence")
    .lean();

  let maxSeq = 0;
  for (const po of pos) {
    for (const so of po.secondaryOutward || []) {
      if (String(so.linkedDispatchId) !== String(dispatchId)) continue;
      const seq = Number(so.dispatchFulfillmentSequence) || 0;
      if (seq > maxSeq) maxSeq = seq;
    }
  }
  return maxSeq + 1;
};

const shadeMatchesPollyhouse = (pollyhouseRaw, shadeName, shadeNumber) => {
  const ph = String(pollyhouseRaw || "").trim().toLowerCase();
  if (!ph) return false;
  const name = String(shadeName || "").trim().toLowerCase();
  const num = String(shadeNumber || "").trim().toLowerCase();
  if (name && ph === name) return true;
  if (num && ph === num) return true;
  if (name && ph.includes(name)) return true;
  if (num && ph.includes(num)) return true;
  return false;
};

/** Batch summary for Dispatch tab: only dispatch-eligible stock — split calendar vs Mark ready (bypass). */
const buildDispatchReadyByBatch = (enrichedLines) => {
  const map = new Map();
  for (const line of enrichedLines) {
    if (!line.dispatchEligible) continue;
    const si = line.secondaryInward;
    const avail = safeNonNegativeInt(
      safeMongooseNumber(si?.availableQuantity),
      0
    );
    if (avail < 1) continue;
    const bid = String(line.batchId);
    const bypassAt = line.readinessBypassAt ?? si?.readinessBypassAt;
    const viaBypass = bypassAt != null;
    if (!map.has(bid)) {
      map.set(bid, {
        batchId: line.batchId,
        batchNumber: line.batchNumber,
        plantLabel: line.plantLabel,
        subtypeLabel: line.subtypeLabel,
        totalAvailPlants: 0,
        /** Eligible by planting date + secondary-ready days (no bypass on line) */
        plantsCalendarReady: 0,
        /** Eligible after Mark ready (override) on Inward */
        plantsMarkReady: 0,
        linesCount: 0,
        linesCalendarReady: 0,
        linesMarkReady: 0,
        nextReadyDate: null,
        hasEligibleLine: true,
      });
    }
    const agg = map.get(bid);
    agg.totalAvailPlants += avail;
    agg.linesCount += 1;
    if (viaBypass) {
      agg.plantsMarkReady += avail;
      agg.linesMarkReady += 1;
    } else {
      agg.plantsCalendarReady += avail;
      agg.linesCalendarReady += 1;
    }
    const rd = line.expectedReadyByCalendar;
    if (rd) {
      const m = moment(rd);
      if (!agg.nextReadyDate || m.isBefore(moment(agg.nextReadyDate))) {
        agg.nextReadyDate = rd;
      }
    }
  }
  return [...map.values()].sort((a, b) =>
    String(a.batchNumber || "").localeCompare(String(b.batchNumber || ""), undefined, {
      numeric: true,
    })
  );
};

/** Dispatch-eligible stock grouped by pollyhouse / shed. */
const buildDispatchReadyByShed = (enrichedLines) => {
  const map = new Map();
  for (const line of enrichedLines) {
    if (!line.dispatchEligible) continue;
    const si = line.secondaryInward;
    const avail = safeNonNegativeInt(
      safeMongooseNumber(si?.availableQuantity),
      0
    );
    if (avail < 1) continue;
    const shed = String(si?.pollyhouse || "—").trim() || "—";
    const bypassAt = line.readinessBypassAt ?? si?.readinessBypassAt;
    const viaBypass = bypassAt != null;
    if (!map.has(shed)) {
      map.set(shed, {
        pollyhouse: shed,
        totalAvailPlants: 0,
        plantsCalendarReady: 0,
        plantsMarkReady: 0,
        lineCount: 0,
        batchIds: new Set(),
      });
    }
    const agg = map.get(shed);
    agg.totalAvailPlants += avail;
    agg.lineCount += 1;
    agg.batchIds.add(String(line.batchId));
    if (viaBypass) agg.plantsMarkReady += avail;
    else agg.plantsCalendarReady += avail;
  }
  return [...map.values()]
    .map((r) => ({ ...r, batchCount: r.batchIds.size, batchIds: undefined }))
    .sort((a, b) => b.totalAvailPlants - a.totalAvailPlants);
};

/** Lines past expected ready date with stock remaining. */
const buildPastDueSecondaryInward = (enrichedLines, todayStart) => {
  const out = [];
  for (const line of enrichedLines) {
    const si = line.secondaryInward;
    const avail = safeNonNegativeInt(
      safeMongooseNumber(si?.availableQuantity ?? si?.totalQuantity),
      0
    );
    if (avail < 1) continue;
    const expected =
      line.expectedReadyByCalendar ||
      (si?.expectedReadyDate ? moment(si.expectedReadyDate).toISOString() : null);
    if (!expected) continue;
    const expM = moment(expected).startOf("day");
    if (!expM.isValid() || !todayStart.isAfter(expM, "day")) continue;
    const daysPastDue = todayStart.diff(expM, "days");
    out.push({
      plantOutwardId: line.plantOutwardId,
      batchId: line.batchId,
      batchNumber: line.batchNumber,
      plantLabel: line.plantLabel,
      subtypeLabel: line.subtypeLabel,
      secondaryInward: si,
      pollyhouse: si?.pollyhouse ?? "—",
      size: si?.size,
      availPlants: avail,
      daysPastDue,
      dispatchEligible: Boolean(line.dispatchEligible),
      readinessBypassAt: line.readinessBypassAt ?? si?.readinessBypassAt ?? null,
      expectedReadyByCalendar: expected,
    });
  }
  return out.sort((a, b) => b.daysPastDue - a.daysPastDue);
};

const enrichSecondaryInwardLineForDashboard = (line, todayStart) => {
  const si = line.secondaryInward;
  const bypassAt = line.readinessBypassAt ?? si?.readinessBypassAt;
  const bypass = bypassAt != null;
  const expected =
    line.expectedReadyByCalendar ||
    (si?.expectedReadyDate ? moment(si.expectedReadyDate).toISOString() : null);
  let daysPastDue = 0;
  let readySource = "upcoming";
  if (bypass) {
    readySource = "bypass";
  } else if (expected) {
    const expM = moment(expected).startOf("day");
    if (expM.isValid()) {
      const diff = expM.diff(todayStart, "days");
      if (diff < 0) {
        daysPastDue = Math.abs(diff);
        readySource = line.dispatchEligible ? "past_due_ready" : "past_due";
      } else if (diff === 0 && line.dispatchEligible) {
        readySource = "calendar";
      } else if (line.dispatchEligible) {
        readySource = "calendar";
      }
    }
  }
  return {
    ...line,
    pollyhouse: si?.pollyhouse ?? "—",
    daysPastDue,
    readySource,
    linkedSlotReadyDate: expected,
  };
};

/** Align DispatchBatch.batchNumber with Sowing.batchNumber (trim, string, legacy types). */
const normBatchNumber = (v) => {
  if (v == null || v === "") return "";
  return String(v).trim();
};

const parseSowingDateToMoment = (raw) => {
  if (raw == null || raw === "") return null;
  const strict = moment(raw, "DD-MM-YYYY", true);
  if (strict.isValid()) return strict.startOf("day");
  const alt = moment(raw, ["DD/MM/YYYY", "MM-DD-YYYY", "YYYY-MM-DD"], true);
  if (alt.isValid()) return alt.startOf("day");
  const iso = moment(raw);
  return iso.isValid() ? iso.startOf("day") : null;
};

/** Days remaining until primary / secondary plant-ready targets (sowing anchor + batch ready days). */
const buildPlantReadyMeta = async (batchId) => {
  const batch = await DispatchBatch.findById(batchId)
    .select(BATCH_SELECT_FIELDS)
    .populate("plantCmsId", "name subtypes")
    .lean();
  if (!batch) {
    return {
      hasAnchor: false,
      reason: "batch_not_found",
      primaryPlantReadyDays: 0,
      secondaryPlantReadyDays: 0,
    };
  }
  const bn = normBatchNumber(batch.batchNumber);
  const primaryDays = batch.primaryPlantReadyDays ?? 0;
  const secondaryDays = batch.secondaryPlantReadyDays ?? 0;

  if (!bn) {
    return {
      hasAnchor: false,
      batchId: String(batchId),
      batchNumber: null,
      primaryPlantReadyDays: primaryDays,
      secondaryPlantReadyDays: secondaryDays,
      batchPlantReadyDaysSource: "dispatch_batch",
    };
  }

  const sowingFilter = buildSowingMatchForSingleBatch(batchId, bn);
  const sowingRows = sowingFilter
    ? await Sowing.find(sowingFilter).select("batchNumber sowingDate").lean()
    : [];

  let anchor = null;
  for (const row of sowingRows) {
    const m = parseSowingDateToMoment(row.sowingDate);
    if (!m) continue;
    if (!anchor || m.isBefore(anchor)) anchor = m;
  }

  if (!anchor) {
    return {
      hasAnchor: false,
      batchId: String(batchId),
      batchNumber: bn,
      primaryPlantReadyDays: primaryDays,
      secondaryPlantReadyDays: secondaryDays,
      batchPlantReadyDaysSource: "dispatch_batch",
    };
  }

  const today = moment().startOf("day");
  const primaryStageReadyAt = anchor.clone().add(primaryDays, "days");
  const secondaryReadyAt = anchor.clone().add(primaryDays + secondaryDays, "days");

  return {
    hasAnchor: true,
    batchId: String(batchId),
    batchNumber: bn,
    anchorSowingDate: anchor.format("DD-MM-YYYY"),
    primaryPlantReadyDays: primaryDays,
    secondaryPlantReadyDays: secondaryDays,
    /** Calendar days from start of today until each stage date */
    daysRemainingToPrimary: Math.max(0, primaryStageReadyAt.diff(today, "days")),
    daysRemainingToSecondary: Math.max(0, secondaryReadyAt.diff(today, "days")),
    primaryStageReadyAt: primaryStageReadyAt.toISOString(),
    secondaryReadyAt: secondaryReadyAt.toISOString(),
    secondaryStageReadyAt: secondaryReadyAt.toISOString(),
    daysSinceSowing: Math.max(0, today.diff(anchor, "days")),
  };
};

/** Same numeric rules as labToPrimaryInward for lab line totals and transfer sums */
const computeLabLineStock = (lab) => {
  const labBottlesTotal = safeMongooseNumber(lab.bottles);
  const labPlantsTotal = safeMongooseNumber(lab.plants);
  const transferredBottlesSoFar = (lab.transferHistory || []).reduce(
    (sum, t) => sum + safeNonNegativeInt(t?.bottlesTransferred, 0),
    0
  );
  const transferredPlantsSoFar = (lab.transferHistory || []).reduce(
    (sum, t) => sum + safeNonNegativeInt(t?.plantsTransferred, 0),
    0
  );
  const bottlesTotal = safeNonNegativeInt(labBottlesTotal, 0);
  const plantsTotal = safeNonNegativeInt(labPlantsTotal, 0);
  let bottlesRemaining = safeSubtractNonNegative(bottlesTotal, transferredBottlesSoFar);
  let plantsRemaining = safeSubtractNonNegative(plantsTotal, transferredPlantsSoFar);
  if (lab.availableBottles != null) {
    bottlesRemaining = Math.max(0, safeNonNegativeInt(lab.availableBottles, 0));
  }
  if (lab.availablePlants != null) {
    plantsRemaining = Math.max(0, safeNonNegativeInt(lab.availablePlants, 0));
  }
  return {
    bottlesTotal,
    plantsTotal,
    bottlesTransferred: transferredBottlesSoFar,
    plantsTransferred: transferredPlantsSoFar,
    bottlesRemaining,
    plantsRemaining,
  };
};

/** Lab line is usable for primary inward: accepted (or legacy missing status), not rejected */
const isLabLineAcceptedForPrimary = (lab) => {
  const st = lab.primaryReviewStatus;
  if (st === "pending" || st === "rejected") return false;
  return true;
};

/** Build accepted lab lines list; works even when batchId populate is null (uses raw ref). */
const collectAcceptedLabLines = (plantOutwards) => {
  const acceptedLabLines = [];
  for (const po of plantOutwards) {
    const b = po.batchId;
    const resolvedBatchId = b?._id ?? po.batchId;
    const batchNum = b?.batchNumber ?? null;
    for (const lab of po.outward || []) {
      if (!isLabLineAcceptedForPrimary(lab)) continue;
      const stock = computeLabLineStock(lab);
      const labObj =
        typeof lab.toObject === "function"
          ? lab.toObject({ virtuals: false })
          : { ...lab };
      acceptedLabLines.push({
        plantOutwardId: po._id,
        batchId: resolvedBatchId,
        batchNumber: batchNum ?? String(resolvedBatchId),
        labEntryId: lab._id,
        labEntry: labObj,
        ...stock,
      });
    }
  }
  return acceptedLabLines;
};

const addLabEntry = catchAsync(async (req, res, next) => {
  const { batchId, labData } = req.body;

  // console.log("Received payload:", { batchId, labData });

  let plantOutward = await PlantOutward.findOne({ batchId });
  if (!plantOutward) {
    const batch = await DispatchBatch.findById(batchId);
    if (!batch) {
      return next(new AppError("No dispatch batch found with that batch ID", 404));
    }
    plantOutward = await PlantOutward.create({
      batchId: batch._id,
      dateAdded: batch.dateAdded || new Date(),
    });
  }

  // Create a proper lab entry object with exact schema match
  const newLabEntry = {
    outwardDate: new Date(labData.outwardDate),
    size: labData.size,
    bottles: Number(labData.bottles), // Using Number instead of parseInt
    plants: Number(labData.plants),
    rootingDate: new Date(labData.rootingDate),
    primaryReviewStatus: "pending",
  };

  // Log the formatted entry for debugging
  // console.log("Formatted lab entry:", newLabEntry);

  try {
    // Use findOneAndUpdate instead of save to ensure proper validation
    const updatedPlantOutward = await PlantOutward.findOneAndUpdate(
      { _id: plantOutward._id },
      { $push: { outward: newLabEntry } },
      {
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      }
    );

    if (!updatedPlantOutward) {
      return next(new AppError("Failed to update plant outward", 400));
    }

    const response = generateResponse(
      "Success",
      "Lab entry added successfully",
      updatedPlantOutward,
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    console.error("Validation/Save Error:", error);
    return next(
      new AppError(`Error processing lab entry: ${error.message}`, 400)
    );
  }
});

const updateLabEntry = catchAsync(async (req, res, next) => {
  const { batchId, labId, labData } = req.body; // Removed outwardId as it's no longer needed

  const doc = await PlantOutward.findOneAndUpdate(
    {
      batchId,
      "outward._id": labId, // Simplified query
    },
    {
      $set: { "outward.$": labData }, // Updated to directly set the lab entry
    },
    {
      new: true,
      runValidators: true,
    }
  );

  if (!doc) {
    return next(
      new AppError("No matching plant outward or lab entry found", 404)
    );
  }

  const response = generateResponse(
    "Success",
    "Lab entry updated successfully",
    doc,
    undefined
  );

  return res.status(200).json(response);
});

/** Accept or reject a lab outward line before primary can record inward */
const patchLabReviewStatus = catchAsync(async (req, res, next) => {
  const { batchId, labId } = req.params;
  const { action, rejectionReason } = req.body;
  const userId = req.user?._id;

  if (!action || !["accept", "reject"].includes(action)) {
    return next(new AppError("action must be accept or reject", 400));
  }

  const plantOutward = await PlantOutward.findOne({ batchId });
  if (!plantOutward) {
    return next(new AppError("No plant outward found with this batch ID", 404));
  }

  const labEntry = plantOutward.outward.id(labId);
  if (!labEntry) {
    return next(new AppError("Lab entry not found", 404));
  }

  const setPayload =
    action === "accept"
      ? {
          "outward.$.primaryReviewStatus": "accepted",
          "outward.$.acceptedAt": new Date(),
          "outward.$.acceptedBy": userId,
          "outward.$.rejectionReason": null,
        }
      : {
          "outward.$.primaryReviewStatus": "rejected",
          "outward.$.acceptedAt": null,
          "outward.$.acceptedBy": null,
          "outward.$.rejectionReason": (rejectionReason && String(rejectionReason).trim()) || "Rejected",
        };

  const doc = await PlantOutward.findOneAndUpdate(
    { batchId, "outward._id": labId },
    { $set: setPayload },
    { new: true, runValidators: true }
  );

  if (!doc) {
    return next(new AppError("Failed to update lab review status", 400));
  }

  const response = generateResponse(
    "Success",
    action === "accept" ? "Lab outward accepted" : "Lab outward rejected",
    doc,
    undefined
  );

  return res.status(200).json(response);
});

// getAllPlantOutwards remains the same as it doesn't deal with the internal structure
const getAllPlantOutwards = catchAsync(async (req, res, next) => {
  const {
    batchId,
    startDate,
    endDate,
    primary,
    lab,
    labroot,
    primaryexpected,
  } = req.query;

  // Initialize query object
  const queryObj = {};

  // Add batchId filter if provided
  if (batchId) {
    queryObj.batchId = batchId;
  }

  // Handle date range filters based on different conditions
  if (startDate && endDate) {
    // Convert dates to ISO format
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999); // Include the entire end date

    if (primary === "true") {
      // Search in primaryInward array for primaryInwardDate
      queryObj["primaryInward"] = {
        $elemMatch: {
          primaryInwardDate: {
            $gte: start,
            $lte: end,
          },
        },
      };
    } else if (lab === "true") {
      // Search in outward array for outwardDate
      queryObj["outward"] = {
        $elemMatch: {
          outwardDate: {
            $gte: start,
            $lte: end,
          },
        },
      };
    } else if (labroot === "true") {
      // Search in outward array for rootingDate
      queryObj["outward"] = {
        $elemMatch: {
          rootingDate: {
            $gte: start,
            $lte: end,
          },
        },
      };
    } else if (primaryexpected === "true") {
      // Search in primaryInward array for primaryOutwardExpectedDate
      queryObj["primaryInward"] = {
        $elemMatch: {
          primaryOutwardExpectedDate: {
            $gte: start,
            $lte: end,
          },
        },
      };
    }
  }

  // Build and execute query
  const query = PlantOutward.find(queryObj).populate(BATCH_POPULATE).sort("-createdAt");

  let outwards = await query;

  const includeEmpty =
    req.query.includeEmpty === "true" || req.query.includeEmpty === "1";
  if (!includeEmpty) {
    outwards = outwards.filter((po) => {
      const o = typeof po.toObject === "function" ? po.toObject() : po;
      return (
        (o.outward?.length > 0) ||
        (o.primaryInward?.length > 0) ||
        (o.primaryOutward?.length > 0) ||
        (o.secondaryInward?.length > 0) ||
        (o.secondaryOutward?.length > 0)
      );
    });
  }

  // If no results found, return empty array with success status
  if (!outwards.length) {
    return res.status(200).json({
      status: "Success",
      message: "No plant outwards found matching the criteria",
      data: [],
    });
  }

  return res.status(200).json({
    status: "Success",
    message: "Plant outwards retrieved successfully",
    data: outwards,
  });
});

// getPlantOutwardByBatchId remains the same as it doesn't deal with the internal structure
const getPlantOutwardByBatchId = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;

  const outward = await PlantOutward.findOne({ batchId }).populate(BATCH_POPULATE);

  if (!outward) {
    return next(new AppError("No plant outward found for this batch", 404));
  }

  return res.status(200).json({
    status: "Success",
    message: "Plant outward retrieved successfully",
    data: outward,
  });
});

/**
 * Shared: outwards + sowing + dispatch batch plant-ready map (primary + secondary stage dates).
 * Used by primary and secondary mobile dashboards.
 */
const buildPlantReadyBundleForMobile = async (upcomingDays) => {
  const windowDays = Math.min(Math.max(parseInt(upcomingDays, 10) || 7, 1), 31);
  const today = moment().startOf("day");
  // Inclusive window: "7 days" = today through today+6 (not today+7).
  const windowEnd = today.clone().add(windowDays - 1, "days").endOf("day");

  const plantOutwards = await PlantOutward.find({})
    .populate(BATCH_POPULATE)
    .sort("-updatedAt");

  const batchIdRefs = plantOutwards
    .map((po) => {
      const ref = po.batchId;
      if (!ref) return null;
      return ref._id ? ref._id : ref;
    })
    .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)));

  const uniqueBatchIds = [...new Set(batchIdRefs.map((id) => String(id)))].map(
    (s) => new mongoose.Types.ObjectId(s)
  );

  const batchesFromDb =
    uniqueBatchIds.length > 0
      ? await DispatchBatch.find({ _id: { $in: uniqueBatchIds } })
          .select(BATCH_SELECT_FIELDS)
          .populate("plantCmsId", "name subtypes")
          .lean()
      : [];

  const batchByIdStr = new Map(batchesFromDb.map((b) => [b._id.toString(), b]));

  const batchNumbers = [
    ...new Set(
      batchesFromDb.map((b) => normBatchNumber(b.batchNumber)).filter(Boolean)
    ),
  ];

  const batchObjectIds = batchesFromDb.map((b) => b._id);

  const sowingFilter = buildSowingMatchForBatchList(batchObjectIds, batchNumbers);
  const sowingRows = sowingFilter
    ? await Sowing.find(sowingFilter)
        .select("batchNumber sowingDate dispatchBatchId")
        .lean()
    : [];

  const batchNumByDispatchId = new Map();
  for (const b of batchesFromDb) {
    const n = normBatchNumber(b.batchNumber);
    if (n) batchNumByDispatchId.set(b._id.toString(), n);
  }

  const earliestByBatch = new Map();
  for (const row of sowingRows) {
    const m = parseSowingDateToMoment(row.sowingDate);
    if (!m) continue;
    const keys = new Set();
    const nb = normBatchNumber(row.batchNumber);
    if (nb) keys.add(nb);
    const rowNv = batchNumericValue(nb);
    if (rowNv != null) {
      for (const bn of batchNumbers) {
        if (batchNumericValue(bn) === rowNv) keys.add(bn);
      }
    }
    if (row.dispatchBatchId) {
      const linked = batchNumByDispatchId.get(String(row.dispatchBatchId));
      if (linked) keys.add(linked);
    }
    for (const k of keys) {
      const prev = earliestByBatch.get(k);
      if (!prev || m.isBefore(prev)) earliestByBatch.set(k, m);
    }
  }

  const batchDocByNumber = new Map();
  for (const b of batchesFromDb) {
    const bn = normBatchNumber(b.batchNumber);
    if (bn) batchDocByNumber.set(bn, b);
  }

  const plantReadyByBatchNumber = {};
  for (const bn of batchNumbers) {
    const key = bn;
    const bdoc = batchDocByNumber.get(bn);
    const anchor = earliestByBatch.get(bn) || null;
    const primaryDays = bdoc
      ? Number(safeMongooseNumber(bdoc.primaryPlantReadyDays)) || 0
      : 0;
    const secondaryDays = bdoc
      ? Number(safeMongooseNumber(bdoc.secondaryPlantReadyDays)) || 0
      : 0;
    const batchIdStr = bdoc?._id ? String(bdoc._id) : undefined;

    if (!bdoc || !anchor) {
      plantReadyByBatchNumber[key] = {
        hasAnchor: false,
        batchNumber: key,
        batchId: batchIdStr,
        primaryPlantReadyDays: primaryDays,
        secondaryPlantReadyDays: secondaryDays,
        batchPlantReadyDaysSource: "dispatch_batch",
      };
      continue;
    }
    const primaryStageReadyAt = anchor.clone().add(primaryDays, "days");
    const secondaryReadyAt = anchor.clone().add(primaryDays + secondaryDays, "days");
    plantReadyByBatchNumber[key] = {
      hasAnchor: true,
      batchNumber: key,
      batchId: batchIdStr,
      anchorSowingDate: anchor.format("DD-MM-YYYY"),
      primaryStageReadyAt: primaryStageReadyAt.toISOString(),
      secondaryReadyAt: secondaryReadyAt.toISOString(),
      secondaryStageReadyAt: secondaryReadyAt.toISOString(),
      daysToPrimary: Math.max(0, primaryStageReadyAt.diff(today, "days")),
      daysToSecondary: Math.max(0, secondaryReadyAt.diff(today, "days")),
      primaryPlantReadyDays: primaryDays,
      secondaryPlantReadyDays: secondaryDays,
      batchPlantReadyDaysSource: "dispatch_batch",
    };
  }

  return {
    plantOutwards,
    batchByIdStr,
    earliestByBatch,
    plantReadyByBatchNumber,
    today,
    windowEnd,
    windowDays,
  };
};

/** Aggregated payload for PRIMARY mobile: pending lab lines, milestone windows, expected primary outward */
const getPrimaryMobileDashboard = catchAsync(async (req, res, next) => {
  const { upcomingDays = 7 } = req.query;
  const {
    plantOutwards,
    batchByIdStr,
    earliestByBatch,
    plantReadyByBatchNumber,
    today,
    windowEnd,
    windowDays,
  } = await buildPlantReadyBundleForMobile(upcomingDays);

  const pendingIncoming = [];
  const upcomingMilestones = [];
  const upcomingPrimaryOutward = [];
  const pastDuePrimaryOutward = [];

  for (const po of plantOutwards) {
    const rawRef = po.batchId;
    const resolvedBatchId = rawRef?._id ?? rawRef;
    const b =
      resolvedBatchId &&
      (batchByIdStr.get(String(resolvedBatchId)) ||
        (typeof rawRef === "object" &&
        rawRef !== null &&
        rawRef.batchNumber != null
          ? rawRef
          : null));
    const batchNum =
      b?.batchNumber != null ? normBatchNumber(b.batchNumber) : null;
    const anchor = batchNum ? earliestByBatch.get(batchNum) || null : null;

    const primaryDays = b
      ? Number(safeMongooseNumber(b.primaryPlantReadyDays)) || 0
      : 0;
    const secondaryDays = b
      ? Number(safeMongooseNumber(b.secondaryPlantReadyDays)) || 0
      : 0;

    let primaryStageReadyAt = null;
    let secondaryReadyAt = null;
    if (anchor) {
      primaryStageReadyAt = anchor.clone().add(primaryDays, "days");
      secondaryReadyAt = anchor.clone().add(primaryDays + secondaryDays, "days");
    }

    for (const lab of po.outward || []) {
      const st = lab.primaryReviewStatus ?? "accepted";
      if (st === "pending") {
        pendingIncoming.push({
          plantOutwardId: po._id,
          batchId: resolvedBatchId,
          batchNumber: batchNum ?? String(resolvedBatchId),
          labEntry: lab,
        });
      }
    }

    if (anchor && primaryStageReadyAt && secondaryReadyAt) {
      const inWindow = (d) =>
        d && d.isSameOrAfter(today) && d.isSameOrBefore(windowEnd);
      if (inWindow(primaryStageReadyAt) || inWindow(secondaryReadyAt)) {
        upcomingMilestones.push({
          plantOutwardId: po._id,
          batchId: resolvedBatchId,
          batchNumber: batchNum ?? "—",
          anchorSowingDate: anchor.format("DD-MM-YYYY"),
          primaryStageReadyAt: primaryStageReadyAt.toISOString(),
          secondaryReadyAt: secondaryReadyAt.toISOString(),
          daysToPrimary: Math.max(0, primaryStageReadyAt.diff(today, "days")),
          daysToSecondary: Math.max(0, secondaryReadyAt.diff(today, "days")),
        });
      }
    }

    const plantReadyMeta = {
      hasAnchor: Boolean(anchor),
      primaryStageReadyAt: primaryStageReadyAt
        ? primaryStageReadyAt.toISOString()
        : null,
      primaryPlantReadyDays: primaryDays,
    };

    for (const pi of po.primaryInward || []) {
      const avail = safeNonNegativeInt(pi.availableQuantity, 0);
      if (avail < 1) continue;

      const expM = resolveEffectivePrimaryOutwardExpectedMoment(pi, plantReadyMeta);
      if (!expM || !expM.isValid()) continue;
      if (!isPrimaryInwardOutwardEligible(pi, today, plantReadyMeta)) continue;

      if (expM.isBefore(today)) {
        pastDuePrimaryOutward.push({
          plantOutwardId: po._id,
          batchId: resolvedBatchId,
          batchNumber: batchNum ?? "—",
          primaryInward: pi,
          expectedDate: expM.toISOString(),
          daysPastDue: today.diff(expM, "days"),
          availablePlants: avail,
        });
      } else if (expM.isSameOrAfter(today) && expM.isSameOrBefore(windowEnd)) {
        upcomingPrimaryOutward.push({
          plantOutwardId: po._id,
          batchId: resolvedBatchId,
          batchNumber: batchNum ?? "—",
          primaryInward: pi,
          expectedDate: expM.toISOString(),
        });
      }
    }
  }

  const acceptedLabLines = collectAcceptedLabLines(plantOutwards);

  if (process.env.DEBUG_PRIMARY_MOBILE === "1") {
    const keys = Object.keys(plantReadyByBatchNumber);
    const withBatchId = keys.filter((k) => plantReadyByBatchNumber[k]?.batchId).length;
    console.log("[primary-mobile-dashboard] plantReadyByBatchNumber", {
      batchNumberKeys: keys.length,
      entriesWithBatchId: withBatchId,
      sample: keys.slice(0, 8).map((k) => ({
        batchNumber: k,
        batchId: plantReadyByBatchNumber[k]?.batchId,
        hasAnchor: plantReadyByBatchNumber[k]?.hasAnchor,
        primaryPlantReadyDays: plantReadyByBatchNumber[k]?.primaryPlantReadyDays,
        secondaryPlantReadyDays: plantReadyByBatchNumber[k]?.secondaryPlantReadyDays,
      })),
    });
  }

  const response = generateResponse(
    "Success",
    "Primary mobile dashboard",
    {
      pendingIncoming,
      upcomingMilestones,
      upcomingPrimaryOutward,
      pastDuePrimaryOutward,
      acceptedLabLines,
      plantReadyByBatchNumber,
      windowDays,
    },
    undefined
  );

  return res.status(200).json(response);
});

/**
 * Secondary nursery mobile: incoming from primary (primary outward stock), secondary-stage milestones,
 * plant-ready (same map — secondary stage dates), expected secondary inward/outward in window.
 */
const getSecondaryMobileDashboard = catchAsync(async (req, res, next) => {
  const { upcomingDays = 7 } = req.query;
  const {
    plantOutwards,
    batchByIdStr,
    earliestByBatch,
    plantReadyByBatchNumber,
    today,
    windowEnd,
    windowDays,
  } = await buildPlantReadyBundleForMobile(upcomingDays);

  const incomingFromPrimary = [];
  const upcomingSecondaryMilestones = [];
  const upcomingSecondaryInwardExpected = [];
  const upcomingSecondaryOutwardExpected = [];
  const availableSecondaryInwardLines = [];

  for (const po of plantOutwards) {
    const rawRef = po.batchId;
    const resolvedBatchId = rawRef?._id ?? rawRef;
    const b =
      resolvedBatchId &&
      (batchByIdStr.get(String(resolvedBatchId)) ||
        (typeof rawRef === "object" &&
        rawRef !== null &&
        rawRef.batchNumber != null
          ? rawRef
          : null));
    const batchNum =
      b?.batchNumber != null ? normBatchNumber(b.batchNumber) : null;
    const anchor = batchNum ? earliestByBatch.get(batchNum) || null : null;

    const primaryDays = b
      ? Number(safeMongooseNumber(b.primaryPlantReadyDays)) || 0
      : 0;
    const secondaryDays = b
      ? Number(safeMongooseNumber(b.secondaryPlantReadyDays)) || 0
      : 0;

    let primaryStageReadyAt = null;
    let secondaryReadyAt = null;
    if (anchor) {
      primaryStageReadyAt = anchor.clone().add(primaryDays, "days");
      secondaryReadyAt = anchor.clone().add(primaryDays + secondaryDays, "days");
    }

    for (const pout of po.primaryOutward || []) {
      const avail = safeNonNegativeInt(
        safeMongooseNumber(
          pout.availableQuantity ?? pout.totalQuantity
        ),
        0
      );
      if (
        avail > 0 &&
        (pout.transferStatus ?? "available") !== "fully_transferred"
      ) {
        incomingFromPrimary.push({
          plantOutwardId: po._id,
          batchId: resolvedBatchId,
          batchNumber: batchNum ?? String(resolvedBatchId),
          primaryOutward: pout,
          secondaryAcknowledgedAt: pout.secondaryAcknowledgedAt ?? null,
          needsSecondaryAccept: pout.secondaryAcknowledgedAt == null,
          ...plantSubtypeLabelsFromLeanBatch(b),
        });
      }
    }

    if (anchor && secondaryReadyAt) {
      const inWindow = (d) =>
        d && d.isSameOrAfter(today) && d.isSameOrBefore(windowEnd);
      if (inWindow(secondaryReadyAt)) {
        upcomingSecondaryMilestones.push({
          plantOutwardId: po._id,
          batchId: resolvedBatchId,
          batchNumber: batchNum ?? "—",
          anchorSowingDate: anchor.format("DD-MM-YYYY"),
          secondaryReadyAt: secondaryReadyAt.toISOString(),
          daysToSecondary: Math.max(0, secondaryReadyAt.diff(today, "days")),
          primaryPlantReadyDays: primaryDays,
          secondaryPlantReadyDays: secondaryDays,
          ...plantSubtypeLabelsFromLeanBatch(b),
        });
      }
    }

    for (const si of po.secondaryInward || []) {
      const expectedRaw = si.secondaryOutwardExpectedDate;
      const fallback = secondaryReadyAt ? secondaryReadyAt.toDate() : null;
      const expected = expectedRaw || fallback;
      if (expected) {
        const expM = moment(expected);
        if (expM.isSameOrAfter(today) && expM.isSameOrBefore(windowEnd)) {
          upcomingSecondaryInwardExpected.push({
            plantOutwardId: po._id,
            batchId: resolvedBatchId,
            batchNumber: batchNum ?? "—",
            secondaryInward: si,
            expectedDate: expM.toISOString(),
            ...plantSubtypeLabelsFromLeanBatch(b),
          });
        }
      }
      const availSi = safeNonNegativeInt(
        safeMongooseNumber(si.availableQuantity ?? si.totalQuantity),
        0
      );
      if (
        availSi > 0 &&
        (si.transferStatus ?? "available") !== "fully_transferred"
      ) {
        const elig = computeSecondaryDispatchEligibility(
          typeof si.toObject === "function" ? si.toObject() : si,
          secondaryDays,
          today
        );
        availableSecondaryInwardLines.push({
          plantOutwardId: po._id,
          batchId: resolvedBatchId,
          batchNumber: batchNum ?? String(resolvedBatchId),
          secondaryInward: si,
          ...plantSubtypeLabelsFromLeanBatch(b),
          ...elig,
        });
      }
    }

    for (const so of po.secondaryOutward || []) {
      const d = moment(so.secondaryOutwardDate);
      if (!d.isValid()) continue;
      if (d.isSameOrAfter(today) && d.isSameOrBefore(windowEnd)) {
        upcomingSecondaryOutwardExpected.push({
          plantOutwardId: po._id,
          batchId: resolvedBatchId,
          batchNumber: batchNum ?? "—",
          secondaryOutward: so,
          expectedDate: d.toISOString(),
          ...plantSubtypeLabelsFromLeanBatch(b),
        });
      }
    }
  }

  const enrichedSecondaryLines = availableSecondaryInwardLines.map((line) =>
    enrichSecondaryInwardLineForDashboard(line, today)
  );

  const dispatchReadyByBatch = buildDispatchReadyByBatch(enrichedSecondaryLines);
  const dispatchReadyByShed = buildDispatchReadyByShed(enrichedSecondaryLines);
  const pastDueSecondaryInward = buildPastDueSecondaryInward(
    enrichedSecondaryLines,
    today
  );

  if (req.query.syncSlotStock === "true" || req.query.syncSlotStock === "1") {
    const userId = req.user?._id || req.user?.id;
    const performedBy =
      userId && mongoose.isValidObjectId(String(userId)) ? userId : undefined;
    let syncedLines = 0;
    for (const line of enrichedSecondaryLines) {
      if (!line.dispatchEligible || syncedLines >= 40) continue;
      const si = line.secondaryInward;
      if (!si?._id || !line.batchId) continue;
      const avail = safeNonNegativeInt(
        safeMongooseNumber(si.availableQuantity),
        0
      );
      const pending =
        avail - safeNonNegativeInt(safeMongooseNumber(si.slotStockSyncedPlants), 0);
      if (pending < 1) continue;
      let batchLean =
        batchByIdStr.get(String(line.batchId)) ||
        (typeof line.batchId === "object" ? line.batchId : null);
      if (!batchLean || !batchLean.plantCmsId) {
        batchLean = await DispatchBatch.findById(line.batchId)
          .select(BATCH_SELECT_FIELDS)
          .lean();
      }
      try {
        const syncResult = await syncSecondaryInwardSlotStockAdd({
          batchId: line.batchId,
          secondaryInwardId: si._id,
          batchLean,
          siPlain: typeof si.toObject === "function" ? si.toObject() : si,
          dispatchEligible: true,
          force: true,
          performedBy,
        });
        if (syncResult?.applied > 0) {
          await recordShedActivity({
            batchId: line.batchId,
            stage: "secondary_inward",
            subdocId: si._id,
            action: SHED_ACTIVITY_ACTIONS.SECONDARY_SLOT_SYNC,
            activityName: `कॅलेंडर रेडी · स्लॉट +${syncResult.applied}`,
            performedBy,
            quantity: syncResult.applied,
            newValue: { slotId: syncResult.slotId },
          });
        }
        syncedLines += 1;
      } catch (slotErr) {
        console.warn(
          "[secondaryShedSlotStock] dashboard sync:",
          slotErr?.message || slotErr
        );
      }
    }
  }

  const response = generateResponse(
    "Success",
    "Secondary mobile dashboard",
    {
      incomingFromPrimary,
      upcomingSecondaryMilestones,
      upcomingSecondaryInwardExpected,
      upcomingSecondaryOutwardExpected,
      availableSecondaryInwardLines: enrichedSecondaryLines,
      dispatchReadyByBatch,
      dispatchReadyByShed,
      pastDueSecondaryInward,
      plantReadyByBatchNumber,
      windowDays,
    },
    undefined
  );

  return res.status(200).json(response);
});

/** PATCH readiness bypass on a secondary inward line (secondary mobile ops). */
const patchSecondaryInwardReadinessBypass = catchAsync(
  async (req, res, next) => {
    const { batchId, secondaryInwardId } = req.params;
    const { reason, clear } = req.body || {};
    const userId = req.user?._id || req.user?.id;

    const plantOutward = await PlantOutward.findOne({ batchId }).populate(
      BATCH_POPULATE
    );
    if (!plantOutward) {
      return next(
        new AppError("No plant outward found with this batch ID", 404)
      );
    }

    const siSub = plantOutward.secondaryInward.id(secondaryInwardId);
    if (!siSub) {
      return next(new AppError("Secondary inward entry not found", 404));
    }

    let b = plantOutward.batchId;
    if (b && typeof b !== "object") {
      b = await DispatchBatch.findById(b).select(BATCH_SELECT_FIELDS).lean();
    }
    const secondaryDays = b
      ? Number(safeMongooseNumber(b.secondaryPlantReadyDays)) || 0
      : 0;

    const prevSnapshot = {
      expectedReadyDate: siSub.expectedReadyDate ?? null,
      linkedBookingSlotId: siSub.linkedBookingSlotId ?? null,
      readinessBypassAt: siSub.readinessBypassAt ?? null,
    };

    if (clear) {
      siSub.readinessBypassAt = null;
      siSub.readinessBypassBy = null;
      siSub.readinessBypassReason = "";
    } else {
      const bypassNow = new Date();
      siSub.readinessBypassAt = bypassNow;
      siSub.expectedReadyDate = bypassNow;
      if (userId && mongoose.isValidObjectId(String(userId))) {
        siSub.readinessBypassBy = userId;
      }
      siSub.readinessBypassReason = String(reason ?? "")
        .trim()
        .slice(0, 500);
    }

    await plantOutward.save({ validateBeforeSave: true });

    const siObj =
      typeof siSub.toObject === "function"
        ? siSub.toObject()
        : { ...siSub };
    const today = moment().startOf("day");
    const elig = computeSecondaryDispatchEligibility(
      siObj,
      secondaryDays,
      today
    );

    let slotRelocate = null;
    if (!clear) {
      let batchLean = b;
      if (batchLean && typeof batchLean !== "object") {
        batchLean = await DispatchBatch.findById(batchLean)
          .select(BATCH_SELECT_FIELDS)
          .lean();
      }
      try {
        slotRelocate = await relocateSecondaryInwardSlotOnBypass({
          batchId,
          secondaryInwardId,
          batchLean,
          siPlain: siObj,
          performedBy:
            userId && mongoose.isValidObjectId(String(userId)) ? userId : undefined,
        });
        await recordShedActivity({
          batchId,
          stage: "secondary_inward",
          subdocId: secondaryInwardId,
          action: SHED_ACTIVITY_ACTIONS.SECONDARY_READINESS_BYPASS,
          activityName: `मार्क रेडी · आजच्या स्लॉटमध्ये`,
          performedBy: userId,
          quantity: safeNonNegativeInt(siObj.availableQuantity, 0),
          previousValue: prevSnapshot,
          newValue: {
            expectedReadyDate: siSub.expectedReadyDate,
            linkedBookingSlotId: slotRelocate?.newSlotId ?? siSub.linkedBookingSlotId,
            slotRelocate,
          },
          reason: siSub.readinessBypassReason,
        });
        if (slotRelocate?.applied > 0) {
          await recordShedActivity({
            batchId,
            stage: "secondary_inward",
            subdocId: secondaryInwardId,
            action: SHED_ACTIVITY_ACTIONS.SECONDARY_SLOT_RELOCATE,
            activityName: `स्लॉट हलवले · +${slotRelocate.applied} actualPlants`,
            performedBy: userId,
            quantity: slotRelocate.applied,
            previousValue: { slotId: slotRelocate.oldSlotId },
            newValue: { slotId: slotRelocate.newSlotId },
            metadata: slotRelocate,
          });
        }
      } catch (slotErr) {
        console.warn("[secondaryShedSlotStock] bypass sync:", slotErr?.message || slotErr);
      }
    } else {
      await recordShedActivity({
        batchId,
        stage: "secondary_inward",
        subdocId: secondaryInwardId,
        action: SHED_ACTIVITY_ACTIONS.SECONDARY_READINESS_BYPASS_CLEARED,
        activityName: "मार्क रेडी रद्द",
        performedBy: userId,
        previousValue: prevSnapshot,
        newValue: {
          expectedReadyDate: siSub.expectedReadyDate,
          linkedBookingSlotId: siSub.linkedBookingSlotId,
        },
        reason: String(reason ?? ""),
      });
    }

    return res.status(200).json(
      generateResponse(
        "Success",
        clear
          ? "Readiness bypass cleared"
          : "Readiness bypass recorded",
        {
          batchId: String(batchId),
          secondaryInwardId: String(secondaryInwardId),
          ...elig,
          slotRelocate,
          secondaryInward: siSub,
        },
        undefined
      )
    );
  }
);

/** Dedicated list of accepted lab lines (same payload as dashboard.acceptedLabLines) */
const getAcceptedLabLines = catchAsync(async (req, res, next) => {
  const plantOutwards = await PlantOutward.find({})
    .populate(BATCH_POPULATE)
    .sort("-updatedAt");

  const acceptedLabLines = collectAcceptedLabLines(plantOutwards);

  const response = generateResponse(
    "Success",
    "Accepted lab lines",
    { acceptedLabLines },
    undefined
  );

  return res.status(200).json(response);
});

const addPrimaryInward = catchAsync(async (req, res, next) => {
  const { batchId, primaryInwardData } = req.body;
  // console.log(primaryInwardData);

  // Calculate total quantity before saving
  primaryInwardData.totalQuantity =
    primaryInwardData.cavity * primaryInwardData.numberOfTrays;
  const size = primaryInwardData.size;

  // Check if plant outward exists for batch
  let plantOutward = await PlantOutward.findOne({ batchId });

  if (!plantOutward) {
    return next(new AppError("No outward entries exist for this batch", 400));
  }

  // Check if there are enough total bottles in the summary for this size
  const currentSummaryForSize = plantOutward.summary[size];
  if (currentSummaryForSize.totalBottles < primaryInwardData.numberOfBottles) {
    return next(
      new AppError(
        `Insufficient bottles available for ${size}. Available: ${currentSummaryForSize.totalBottles - currentSummaryForSize.primaryInwardBottles}, Requested: ${primaryInwardData.numberOfBottles}`,
        400
      )
    );
  }

  // Calculate new summary values
  const newBottles = primaryInwardData.numberOfBottles;
  const newPlants = primaryInwardData.cavity * primaryInwardData.numberOfTrays;

  // Create updated summary
  const updatedSummary = {
    ...plantOutward.summary,
    [size]: {
      ...plantOutward.summary[size],
      primaryInwardBottles:
        plantOutward.summary[size].primaryInwardBottles - newBottles,
      primaryInwardPlants:
        plantOutward.summary[size].primaryInwardPlants - newPlants,
    },
    total: {
      ...plantOutward.summary.total,
      primaryInwardBottles:
        plantOutward.summary.total.primaryInwardBottles - newBottles,
      primaryInwardPlants:
        plantOutward.summary.total.primaryInwardPlants - newPlants,
    },
  };

  // Update document with new primary inward and summary
  plantOutward = await PlantOutward.findOneAndUpdate(
    {
      _id: plantOutward._id,
      // Additional validation in query to ensure totalBottles is still sufficient
      [`summary.${size}.totalBottles`]: {
        $gte: primaryInwardData.numberOfBottles,
      },
    },
    {
      $push: { primaryInward: primaryInwardData },
      $set: { summary: updatedSummary },
    },
    { new: true, runValidators: true }
  );

  if (!plantOutward) {
    return next(
      new AppError(
        "Failed to add primary inward entry - insufficient bottles",
        400
      )
    );
  }

  const response = generateResponse(
    "Success",
    "Primary inward entry added successfully",
    plantOutward,
    undefined
  );

  return res.status(200).json(response);
});

const updatePrimaryInward = catchAsync(async (req, res, next) => {
  const { batchId, primaryInwardId } = req.params;
  const updateData = req.body;

  // Get the current document first to calculate differences
  const currentDoc = await PlantOutward.findOne({
    batchId,
    "primaryInward._id": primaryInwardId,
  });

  if (!currentDoc) {
    return next(new AppError("No matching plant outward found", 404));
  }

  const currentEntry = currentDoc.primaryInward.find(
    (item) => item._id.toString() === primaryInwardId
  );

  if (!currentEntry) {
    return next(new AppError("No matching primary inward entry found", 404));
  }

  // Calculate new total quantity if needed
  if (updateData.cavity || updateData.numberOfTrays) {
    updateData.totalQuantity =
      (updateData.cavity || currentEntry.cavity) *
      (updateData.numberOfTrays || currentEntry.numberOfTrays);
  }

  const size = currentEntry.size;
  const newBottles = updateData.numberOfBottles || currentEntry.numberOfBottles;

  // If updating bottles, check if the difference is available in total bottles
  if (updateData.numberOfBottles) {
    const bottlesDifference = newBottles - currentEntry.numberOfBottles;
    if (bottlesDifference > 0) {
      // If requesting more bottles, check if available
      const availableBottles =
        currentDoc.summary[size].totalBottles + currentEntry.numberOfBottles;
      if (availableBottles < newBottles) {
        return next(
          new AppError(
            `Insufficient bottles available for ${size}. Available: ${availableBottles}, Requested: ${newBottles}`,
            400
          )
        );
      }
    }
  }

  // Calculate all differences for summary update
  const currentPlants = currentEntry.cavity * currentEntry.numberOfTrays;
  const newPlants = updateData.totalQuantity || currentPlants;

  const bottlesDiff = currentEntry.numberOfBottles - newBottles;
  const plantsDiff = currentPlants - newPlants;

  // Create updated summary
  const updatedSummary = {
    ...currentDoc.summary,
    [size]: {
      ...currentDoc.summary[size],
      primaryInwardBottles:
        currentDoc.summary[size].primaryInwardBottles + bottlesDiff,
      primaryInwardPlants:
        currentDoc.summary[size].primaryInwardPlants + plantsDiff,
    },
    total: {
      ...currentDoc.summary.total,
      primaryInwardBottles:
        currentDoc.summary.total.primaryInwardBottles + bottlesDiff,
      primaryInwardPlants:
        currentDoc.summary.total.primaryInwardPlants + plantsDiff,
    },
  };

  // Update document with additional validation
  const doc = await PlantOutward.findOneAndUpdate(
    {
      batchId,
      "primaryInward._id": primaryInwardId,
      // Additional validation in query if increasing bottles
      ...(updateData.numberOfBottles &&
      updateData.numberOfBottles > currentEntry.numberOfBottles
        ? {
            [`summary.${size}.totalBottles`]: {
              $gte: updateData.numberOfBottles - currentEntry.numberOfBottles,
            },
          }
        : {}),
    },
    {
      $set: {
        "primaryInward.$": updateData,
        summary: updatedSummary,
      },
    },
    {
      new: true,
      runValidators: true,
    }
  );

  if (!doc) {
    return next(
      new AppError(
        "Failed to update primary inward entry - insufficient bottles",
        404
      )
    );
  }

  const response = generateResponse(
    "Success",
    "Primary inward entry updated successfully",
    doc,
    undefined
  );

  return res.status(200).json(response);
});

// Helper function to delete a primary inward entry
const deletePrimaryInward = catchAsync(async (req, res, next) => {
  const { batchId, primaryInwardId } = req.params;

  // First get the current entry to calculate summary adjustments
  const currentDoc = await PlantOutward.findOne(
    { batchId, "primaryInward._id": primaryInwardId },
    { "primaryInward.$": 1 }
  );

  if (!currentDoc || !currentDoc.primaryInward[0]) {
    return next(new AppError("No matching primary inward entry found", 404));
  }

  const entryToDelete = currentDoc.primaryInward[0];
  const size = entryToDelete.size;
  const bottlesToAdd = entryToDelete.numberOfBottles;
  const plantsToAdd = entryToDelete.cavity * entryToDelete.numberOfTrays;

  // Update document - remove entry and adjust summary
  const doc = await PlantOutward.findOneAndUpdate(
    { batchId },
    {
      $pull: { primaryInward: { _id: primaryInwardId } },
      $inc: {
        [`summary.${size}.primaryInwardBottles`]: bottlesToAdd,
        [`summary.${size}.primaryInwardPlants`]: plantsToAdd,
        "summary.total.primaryInwardBottles": bottlesToAdd,
        "summary.total.primaryInwardPlants": plantsToAdd,
      },
    },
    { new: true }
  );

  if (!doc) {
    return next(new AppError("Failed to delete primary inward entry", 404));
  }

  const response = generateResponse(
    "Success",
    "Primary inward entry deleted successfully",
    doc,
    undefined
  );

  return res.status(200).json(response);
});

const getPrimaryInwardByBatchId = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;

  const outward = await PlantOutward.findOne({ batchId }).populate(BATCH_POPULATE);

  if (!outward) {
    return next(new AppError("No plant outward found for this batch", 404));
  }

  return res.status(200).json({
    status: "Success",
    message: "Primary inward entries retrieved successfully",
    data: outward.primaryInward,
  });
});

const labToPrimaryInward = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;
  const {
    labEntryId,  // Added this as source
    primaryInwardDate,
    numberOfBottles,
    size,
    cavity,
    numberOfTrays,
    pollyhouse,
    laboursEngaged,
    remarks
  } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Validate required fields
    if (
      !labEntryId ||
      !primaryInwardDate ||
      !numberOfBottles ||
      !size ||
      !cavity ||
      !numberOfTrays ||
      !pollyhouse ||
      laboursEngaged == null
    ) {
      throw new AppError("Missing required fields", 400);
    }

    // Find and validate plant outward document
    const plantOutward = await PlantOutward.findOne({ batchId }).session(session);
    if (!plantOutward) {
      throw new AppError("No plant outward found with this batch ID", 404);
    }

    // Find and validate lab entry
    const labEntry = plantOutward.outward.id(labEntryId);
    if (!labEntry) {
      throw new AppError("Lab entry not found", 404);
    }

    const reviewStatus = labEntry.primaryReviewStatus;
    if (reviewStatus === "rejected") {
      throw new AppError("Lab outward was rejected; cannot record inward", 400);
    }
    if (reviewStatus === "pending") {
      throw new AppError(
        "Lab outward must be accepted by primary before inward",
        403
      );
    }

    if (size !== labEntry.size) {
      throw new AppError(
        `Size must match the lab line (${labEntry.size}). Got: ${size}`,
        400
      );
    }

    const numBottles = Number(numberOfBottles);
    if (!Number.isFinite(numBottles) || numBottles < 1) {
      throw new AppError("numberOfBottles must be a positive number", 400);
    }

    const cavityN = Number(cavity);
    const traysN = Number(numberOfTrays);
    if (
      !Number.isFinite(cavityN) ||
      !Number.isFinite(traysN) ||
      cavityN < 1 ||
      traysN < 1
    ) {
      throw new AppError("cavity and numberOfTrays must be positive numbers", 400);
    }

    const labBottlesTotal = safeMongooseNumber(labEntry.bottles);
    const labPlantsTotal = safeMongooseNumber(labEntry.plants);
    if (!Number.isFinite(labBottlesTotal) || labBottlesTotal < 0) {
      throw new AppError(
        "Lab line has invalid bottles on record; fix the lab outward entry",
        400
      );
    }
    if (!Number.isFinite(labPlantsTotal) || labPlantsTotal < 0) {
      throw new AppError(
        "Lab line has invalid plants on record; fix the lab outward entry",
        400
      );
    }

    const transferredBottlesSoFar = (labEntry.transferHistory || []).reduce(
      (sum, t) => sum + safeNonNegativeInt(t?.bottlesTransferred, 0),
      0
    );
    const transferredPlantsSoFar = (labEntry.transferHistory || []).reduce(
      (sum, t) => sum + safeNonNegativeInt(t?.plantsTransferred, 0),
      0
    );
    const availableBottlesFromLab = safeSubtractNonNegative(
      labBottlesTotal,
      transferredBottlesSoFar
    );
    const availablePlantsFromLab = safeSubtractNonNegative(
      labPlantsTotal,
      transferredPlantsSoFar
    );

    if (numBottles > availableBottlesFromLab) {
      throw new AppError(
        `Bottles cannot exceed what remains on this accepted lab line. Requested: ${numBottles}, available: ${availableBottlesFromLab} (lab line: ${labBottlesTotal} bottles total)`,
        400
      );
    }

    // Calculate plant quantity for this inward (trays × cavity)
    const calculatedTotalQuantity = cavityN * traysN;

    if (calculatedTotalQuantity > availablePlantsFromLab) {
      throw new AppError(
        `Plants (trays × cavity) cannot exceed what remains on this lab line. Required: ${calculatedTotalQuantity}, available plants: ${availablePlantsFromLab} (lab line: ${labPlantsTotal} plants total)`,
        400
      );
    }

    // Expected primary outward date: sowing-anchored primary stage when available; else inward + batch primary days
    const plantReadyCountdown = await buildPlantReadyMeta(batchId);
    let primaryOutwardExpectedDate;
    if (plantReadyCountdown.hasAnchor && plantReadyCountdown.primaryStageReadyAt) {
      primaryOutwardExpectedDate = new Date(plantReadyCountdown.primaryStageReadyAt);
    } else {
      const pd = Number(safeMongooseNumber(plantReadyCountdown.primaryPlantReadyDays)) || 0;
      const m = moment(primaryInwardDate);
      if (pd > 0 && m.isValid()) {
        primaryOutwardExpectedDate = m.clone().startOf("day").add(pd, "days").toDate();
      }
    }

    // Create transfer history entry for lab
    const labTransferHistory = {
      transferDate: primaryInwardDate,
      bottlesTransferred: numBottles,
      plantsTransferred: calculatedTotalQuantity,
      remarks
    };

    // Create primary inward entry
    const primaryInwardEntry = {
      primaryInwardDate,
      numberOfBottles: numBottles,
      size,
      cavity: cavityN,
      numberOfTrays: traysN,
      totalQuantity: calculatedTotalQuantity,
      availableQuantity: calculatedTotalQuantity,
      pollyhouse,
      laboursEngaged,
      transferStatus: "available",
      sourceLabId: labEntryId,
      remarks: remarks || undefined,
      ...(primaryOutwardExpectedDate && {
        primaryOutwardExpectedDate,
      }),
    };

    const newAvailableBottles = clampUintForDb(
      safeSubtractNonNegative(availableBottlesFromLab, numBottles)
    );
    const newAvailablePlants = clampUintForDb(
      safeSubtractNonNegative(availablePlantsFromLab, calculatedTotalQuantity)
    );
    const newLabStatus =
      newAvailablePlants === 0 && newAvailableBottles === 0
        ? "fully_transferred"
        : "partially_transferred";

    const updatedDoc = await PlantOutward.findOneAndUpdate(
      { batchId, "outward._id": labEntryId },
      {
        $push: {
          primaryInward: primaryInwardEntry,
          "outward.$.transferHistory": labTransferHistory
        },
        $set: {
          "outward.$.transferStatus": newLabStatus,
          "outward.$.availablePlants": newAvailablePlants,
          "outward.$.availableBottles": newAvailableBottles
        }
      },
      { new: true, session, runValidators: true }
    );

    await session.commitTransaction();

    const docPlain =
      typeof updatedDoc.toObject === "function"
        ? updatedDoc.toObject({ virtuals: false })
        : { ...updatedDoc };

    const response = generateResponse(
      "Success",
      "Transfer from lab to primary completed successfully",
      {
        ...docPlain,
        plantReadyCountdown,
      },
      undefined
    );

    res.status(200).json(response);
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});

/** Plant-ready default from FIFO anchor batch; optional client override. */
const resolvePrimaryOutwardExpectedDate = async ({
  anchorBatchId,
  primaryInwardDate,
  explicitExpectedDate,
  overrideDays,
}) => {
  if (explicitExpectedDate) {
    const d = new Date(explicitExpectedDate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const days = safeNonNegativeInt(overrideDays, 0);
  if (days > 0) {
    const m = moment(primaryInwardDate);
    if (m.isValid()) return m.clone().startOf("day").add(days, "days").toDate();
  }
  const meta = await buildPlantReadyMeta(anchorBatchId);
  if (meta.hasAnchor && meta.primaryStageReadyAt) {
    return new Date(meta.primaryStageReadyAt);
  }
  const pd = Number(safeMongooseNumber(meta.primaryPlantReadyDays)) || 0;
  const m = moment(primaryInwardDate);
  if (pd > 0 && m.isValid()) {
    return m.clone().startOf("day").add(pd, "days").toDate();
  }
  return null;
};

const buildSuggestedPlantReady = async (anchorBatchId, primaryInwardDate) => {
  const meta = await buildPlantReadyMeta(anchorBatchId);
  let suggestedPrimaryOutwardExpectedDate = null;
  let plantReadySource = "inward_plus_days";
  if (meta.hasAnchor && meta.primaryStageReadyAt) {
    suggestedPrimaryOutwardExpectedDate = meta.primaryStageReadyAt;
    plantReadySource = "sowing_anchor";
  } else {
    const pd = Number(safeMongooseNumber(meta.primaryPlantReadyDays)) || 0;
    const m = moment(primaryInwardDate || new Date());
    if (pd > 0 && m.isValid()) {
      suggestedPrimaryOutwardExpectedDate = m
        .clone()
        .startOf("day")
        .add(pd, "days")
        .toISOString();
    }
  }
  return {
    anchorBatchId: String(anchorBatchId),
    anchorBatchNumber: meta.batchNumber ?? null,
    suggestedPrimaryPlantReadyDays:
      Number(safeMongooseNumber(meta.primaryPlantReadyDays)) || 0,
    suggestedPrimaryOutwardExpectedDate,
    plantReadySource,
  };
};

/** Split user size rows across batches by each batch's bottle FIFO share. */
const splitSizeRowsForBatch = (
  batchBottleShare,
  totalBottles,
  sizeSplit,
  sizeRows,
  cavity,
) => {
  const cav = Math.max(1, safeNonNegativeInt(cavity, 126));
  const ratio = totalBottles > 0 ? batchBottleShare / totalBottles : 0;
  if (ratio <= 0) return [];

  const sizes = ["R1", "R2", "R3"];
  const rows = sizes.flatMap((size) => {
    const totalPlants = safeNonNegativeInt(sizeSplit?.[size], 0);
    if (totalPlants < 1) return [];
    const sr = (sizeRows || []).find((r) => r.size === size);
    const totalBottlesForSize = safeNonNegativeInt(sr?.numberOfBottles, 0);
    const plants = Math.max(1, Math.round(totalPlants * ratio));
    const bottles =
      totalBottlesForSize > 0
        ? Math.max(1, Math.round(totalBottlesForSize * ratio))
        : Math.max(1, Math.round(batchBottleShare * (plants / totalPlants)));
    return [
      {
        size,
        plants,
        numberOfTrays: Math.max(1, Math.ceil(plants / cav)),
        numberOfBottles: bottles,
      },
    ];
  });
  return rows;
};

const primaryInwardFifoPreviewGlobal = catchAsync(async (req, res, next) => {
  const {
    totalPlantsSown,
    totalBottlesSown: totalBottlesRaw,
    cavity: cavityRaw,
    sizeSplit: clientSplit,
    primaryInwardDate: previewInwardDate,
  } = req.body ?? {};

  const total = safeNonNegativeInt(totalPlantsSown, 0);
  const enteredBottles = safeNonNegativeInt(totalBottlesRaw, 0);

  if (total < 1) {
    return next(new AppError("totalPlantsSown must be at least 1", 400));
  }
  if (enteredBottles < 1) {
    return next(new AppError("totalBottlesSown must be at least 1", 400));
  }

  const plantOutwards = await PlantOutward.find({}).populate("batchId");
  const pool = collectGlobalAcceptedLabPool(plantOutwards);
  const stock = getAvailableLabStock(pool);

  const bottleCheck = validateBottlesForInward(pool, enteredBottles);
  if (!bottleCheck.ok) {
    return next(new AppError(bottleCheck.error, 400));
  }

  const fifoResult = allocateFifoByBottles(pool, enteredBottles);
  if (!fifoResult.ok) {
    return next(new AppError(fifoResult.error, 400));
  }

  const fifoPlants = fifoResult.allocations.reduce(
    (s, a) => s + safeNonNegativeInt(a.plantsTaken, 0),
    0
  );
  const plantsCheck = validateFifoPlantsVsSown(total, fifoPlants);
  if (!plantsCheck.ok) {
    return next(new AppError(plantsCheck.error, 400));
  }

  const cavity = Math.max(1, safeNonNegativeInt(cavityRaw, 126));
  const sizeSplit = {
    R1: safeNonNegativeInt(clientSplit?.R1, total),
    R2: safeNonNegativeInt(clientSplit?.R2, 0),
    R3: safeNonNegativeInt(clientSplit?.R3, 0),
  };
  if (!clientSplit) {
    sizeSplit.R1 = total;
    sizeSplit.R2 = 0;
    sizeSplit.R3 = 0;
  }
  const splitSum = sizeSplit.R1 + sizeSplit.R2 + sizeSplit.R3;
  if (splitSum !== total) {
    return next(
      new AppError(
        `sizeSplit must sum to totalPlantsSown (${total}). Got ${splitSum}`,
        400
      )
    );
  }

  let sizeRows = suggestSizeRows(sizeSplit, cavity);
  sizeRows = distributeBottlesToSizeRows(sizeRows, enteredBottles);

  const allocationsByBatch = {};
  for (const a of fifoResult.allocations) {
    const bid = String(a.batchId);
    if (!allocationsByBatch[bid]) {
      allocationsByBatch[bid] = { batchId: bid, bottlesTaken: 0, plantsTaken: 0, lines: [] };
    }
    allocationsByBatch[bid].bottlesTaken += safeNonNegativeInt(a.bottlesTaken, 0);
    allocationsByBatch[bid].plantsTaken += safeNonNegativeInt(a.plantsTaken, 0);
    allocationsByBatch[bid].lines.push(a);
  }

  const anchorBatchId = String(fifoResult.allocations[0]?.batchId ?? "");
  const plantReady =
    anchorBatchId
      ? await buildSuggestedPlantReady(anchorBatchId, previewInwardDate || new Date())
      : null;

  return res.status(200).json(
    generateResponse("Success", "Global FIFO preview", {
      fifoAllocations: fifoResult.allocations,
      totalBottlesSuggested: enteredBottles,
      fifoPlantsDerived: fifoPlants,
      sizeRowsSuggested: sizeRows,
      availablePlants: stock.plants,
      availableBottles: stock.bottles,
      allocationsByBatch: Object.values(allocationsByBatch),
      ...(plantReady ?? {}),
    })
  );
});

const labToPrimaryInwardBulkGlobal = catchAsync(async (req, res, next) => {
  const {
    primaryInwardDate,
    pollyhouse,
    cavity,
    totalPlantsSown,
    totalBottlesSown,
    sizeSplit,
    fifoAllocations: clientFifo,
    sizeRows,
    laboursLadies,
    laboursGents,
    remarks,
    primaryPlantReadyDays,
    primaryOutwardExpectedDate: clientExpectedDate,
    numberOfLabTrays: clientLabTrays,
  } = req.body ?? {};

  const total = safeNonNegativeInt(totalPlantsSown, 0);
  const totalBottles = safeNonNegativeInt(totalBottlesSown, 0);
  const cavityN = Math.max(1, safeNonNegativeInt(cavity, 126));
  const numberOfLabTrays =
    clientLabTrays != null && clientLabTrays !== ""
      ? safeNonNegativeInt(clientLabTrays, 0)
      : total >= 1
        ? Math.max(1, Math.ceil(total / 126))
        : 0;
  const ladies = safeNonNegativeInt(laboursLadies, 0);
  const gents = safeNonNegativeInt(laboursGents, 0);
  const laboursEngaged = ladies + gents;

  if (
    !primaryInwardDate ||
    !pollyhouse ||
    total < 1 ||
    totalBottles < 1 ||
    !sizeSplit ||
    !Array.isArray(clientFifo) ||
    !Array.isArray(sizeRows) ||
    laboursEngaged < 1
  ) {
    return next(
      new AppError(
        "Missing required fields: primaryInwardDate, pollyhouse, totalPlantsSown, totalBottlesSown, sizeSplit, fifoAllocations, sizeRows, labours (ladies+gents ≥ 1)",
        400
      )
    );
  }

  const splitSum =
    safeNonNegativeInt(sizeSplit.R1, 0) +
    safeNonNegativeInt(sizeSplit.R2, 0) +
    safeNonNegativeInt(sizeSplit.R3, 0);
  if (splitSum !== total) {
    return next(
      new AppError(
        `sizeSplit must sum to totalPlantsSown (${total}). Got ${splitSum}`,
        400
      )
    );
  }

  const rowBottleSum = sizeRows.reduce(
    (s, r) => s + safeNonNegativeInt(r.numberOfBottles, 0),
    0
  );
  if (rowBottleSum !== totalBottles) {
    return next(
      new AppError(
        `sizeRows bottles (${rowBottleSum}) must equal totalBottlesSown (${totalBottles})`,
        400
      )
    );
  }

  const rowPlantSum = sizeRows.reduce(
    (s, r) => s + safeNonNegativeInt(r.plants, 0),
    0
  );
  if (rowPlantSum !== total) {
    return next(
      new AppError(
        `sizeRows plants (${rowPlantSum}) must equal totalPlantsSown (${total})`,
        400
      )
    );
  }

  for (const row of sizeRows) {
    const sz = String(row.size ?? "");
    const expected = safeNonNegativeInt(sizeSplit[sz], 0);
    const plants = safeNonNegativeInt(row.plants, 0);
    if (expected > 0 && plants !== expected) {
      return next(
        new AppError(
          `sizeRows plants for ${sz} (${plants}) must match sizeSplit (${expected})`,
          400
        )
      );
    }
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const plantOutwards = await PlantOutward.find({}).session(session);
    const poById = new Map(plantOutwards.map((po) => [String(po._id), po]));

    const pool = collectGlobalAcceptedLabPool(plantOutwards);
    const bottleCheck = validateBottlesForInward(pool, totalBottles);
    if (!bottleCheck.ok) {
      throw new AppError(bottleCheck.error, 400);
    }

    const fifoResult = allocateFifoByBottles(pool, totalBottles);
    if (!fifoResult.ok) {
      throw new AppError(fifoResult.error, 400);
    }

    const fifoPlantsBulk = fifoResult.allocations.reduce(
      (s, a) => s + safeNonNegativeInt(a.plantsTaken, 0),
      0
    );
    const plantsCheckBulk = validateFifoPlantsVsSown(total, fifoPlantsBulk);
    if (!plantsCheckBulk.ok) {
      throw new AppError(plantsCheckBulk.error, 400);
    }

    if (!fifoAllocationsMatch(clientFifo, fifoResult.allocations)) {
      throw new AppError(
        "FIFO allocation is stale; refresh preview and try again",
        409
      );
    }

    const fifoAllocations = fifoResult.allocations;
    const inwardSessionId = new mongoose.Types.ObjectId();
    const createdIds = [];
    const touchedPoIds = new Set();

    for (const alloc of fifoAllocations) {
      const plantOutward = poById.get(String(alloc.plantOutwardId));
      if (!plantOutward) {
        throw new AppError(`Plant outward ${alloc.plantOutwardId} not found`, 404);
      }

      const labEntry = plantOutward.outward.id(alloc.labEntryId);
      if (!labEntry) {
        throw new AppError(`Lab entry ${alloc.labEntryId} not found`, 404);
      }
      if (!isLabAcceptedFifo(labEntry)) {
        throw new AppError("Lab line must be accepted before inward", 403);
      }

      const stock = computeLabLineStockFifo(labEntry);
      if (alloc.plantsTaken > stock.plantsRemaining) {
        throw new AppError(
          `Plants exceed remaining on lab line ${alloc.labEntryId}`,
          400
        );
      }
      if (alloc.bottlesTaken > stock.bottlesRemaining) {
        throw new AppError(
          `Bottles exceed remaining on lab line ${alloc.labEntryId}`,
          400
        );
      }

      labEntry.transferHistory.push({
        transferDate: primaryInwardDate,
        bottlesTransferred: alloc.bottlesTaken,
        plantsTransferred: alloc.plantsTaken,
        remarks: remarks || "",
      });

      const newPlants = safeSubtractNonNegative(stock.plantsRemaining, alloc.plantsTaken);
      const newBottles = safeSubtractNonNegative(stock.bottlesRemaining, alloc.bottlesTaken);
      labEntry.availablePlants = clampUintForDb(newPlants);
      labEntry.availableBottles = clampUintForDb(newBottles);
      labEntry.transferStatus =
        newPlants === 0 && newBottles === 0
          ? "fully_transferred"
          : "partially_transferred";

      touchedPoIds.add(String(plantOutward._id));
    }

    const anchorAlloc = fifoAllocations[0];
    if (!anchorAlloc) {
      throw new AppError("FIFO produced no allocations", 400);
    }

    const anchorBatchId = String(anchorAlloc.batchId);
    const anchorPlantOutward = poById.get(String(anchorAlloc.plantOutwardId));
    if (!anchorPlantOutward) {
      throw new AppError(`Plant outward ${anchorAlloc.plantOutwardId} not found`, 404);
    }

    const primaryOutwardExpectedDate = await resolvePrimaryOutwardExpectedDate({
      anchorBatchId,
      primaryInwardDate,
      explicitExpectedDate: clientExpectedDate,
      overrideDays: primaryPlantReadyDays,
    });

    const fifoBatchIds = [
      ...new Set(fifoAllocations.map((a) => String(a.batchId)).filter(Boolean)),
    ];
    const sessionRemarks = [
      remarks?.trim(),
      fifoBatchIds.length > 1 ? `Lab FIFO: ${fifoBatchIds.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const primaryFifoLabId = anchorAlloc.labEntryId;

    for (const row of sizeRows) {
      const size = String(row.size ?? "");
      const plants = safeNonNegativeInt(row.plants, 0);
      if (plants < 1) continue;

      const traysN = safeNonNegativeInt(row.numberOfTrays, 0);
      const numBottles = safeNonNegativeInt(row.numberOfBottles, 0);
      if (traysN < 1 || numBottles < 1) {
        throw new AppError(`Invalid trays/bottles for size ${size}`, 400);
      }
      if (traysN * cavityN < plants) {
        throw new AppError(
          `Trays × cavity (${traysN * cavityN}) is less than plants for ${size} (${plants})`,
          400
        );
      }

      const entry = {
        primaryInwardDate,
        numberOfBottles: numBottles,
        size,
        cavity: cavityN,
        numberOfTrays: traysN,
        ...(numberOfLabTrays > 0 && { numberOfLabTrays }),
        totalQuantity: plants,
        availableQuantity: plants,
        pollyhouse,
        laboursEngaged,
        laboursLadies: ladies,
        laboursGents: gents,
        transferStatus: "available",
        sourceLabId: primaryFifoLabId,
        inwardSessionId,
        remarks: sessionRemarks || undefined,
        ...(primaryOutwardExpectedDate && { primaryOutwardExpectedDate }),
      };

      anchorPlantOutward.primaryInward.push(entry);
      const pushed =
        anchorPlantOutward.primaryInward[anchorPlantOutward.primaryInward.length - 1];
      createdIds.push({
        batchId: anchorBatchId,
        primaryInwardId: String(pushed._id),
      });
    }

    touchedPoIds.add(String(anchorPlantOutward._id));

    if (createdIds.length === 0) {
      throw new AppError("At least one primary inward row is required", 400);
    }

    for (const poId of touchedPoIds) {
      const po = poById.get(poId);
      if (po) {
        await po.save({ session, validateModifiedOnly: true });
      }
    }

    await session.commitTransaction();

    return res.status(200).json(
      generateResponse("Success", "Global bulk primary inward recorded", {
        inwardSessionId: String(inwardSessionId),
        anchorBatchId,
        primaryInwardIds: createdIds,
        fifoAllocations,
      })
    );
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});

const primaryInwardFifoPreview = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;
  const {
    totalPlantsSown,
    totalBottlesSown: totalBottlesRaw,
    cavity: cavityRaw,
    sizeSplit: clientSplit,
  } = req.body ?? {};

  const total = safeNonNegativeInt(totalPlantsSown, 0);
  if (total < 1) {
    return next(new AppError("totalPlantsSown must be at least 1", 400));
  }

  const plantOutward = await PlantOutward.findOne({ batchId });
  if (!plantOutward) {
    return next(new AppError("No plant outward found with this batch ID", 404));
  }

  const pool = collectAcceptedLabPool(plantOutward);
  const stock = getAvailableLabStock(pool);

  if (totalBottlesRaw != null) {
    const bottleCheck = validateBottlesForInward(pool, totalBottlesRaw);
    if (!bottleCheck.ok) {
      return next(new AppError(bottleCheck.error, 400));
    }
  }

  const fifoResult = allocateFifo(pool, total);
  if (!fifoResult.ok) {
    return next(new AppError(fifoResult.error, 400));
  }

  const cavity = Math.max(1, safeNonNegativeInt(cavityRaw, 126));
  const fifoBottles = fifoResult.allocations.reduce(
    (s, a) => s + safeNonNegativeInt(a.bottlesTaken, 0),
    0
  );

  const enteredBottles =
    totalBottlesRaw != null ? safeNonNegativeInt(totalBottlesRaw, 0) : 0;
  if (enteredBottles > 0 && fifoBottles > enteredBottles) {
    return next(
      new AppError(
        `FIFO needs ${fifoBottles} bottles but you entered ${enteredBottles}. Increase bottles or reduce plants.`,
        400
      )
    );
  }

  const totalBottles = enteredBottles > 0 ? enteredBottles : fifoBottles;

  const sizeSplit = {
    R1: safeNonNegativeInt(clientSplit?.R1, total),
    R2: safeNonNegativeInt(clientSplit?.R2, 0),
    R3: safeNonNegativeInt(clientSplit?.R3, 0),
  };
  if (!clientSplit) {
    sizeSplit.R1 = total;
    sizeSplit.R2 = 0;
    sizeSplit.R3 = 0;
  }
  const splitSum = sizeSplit.R1 + sizeSplit.R2 + sizeSplit.R3;
  if (splitSum !== total) {
    return next(
      new AppError(
        `sizeSplit must sum to totalPlantsSown (${total}). Got ${splitSum}`,
        400
      )
    );
  }

  let sizeRows = suggestSizeRows(sizeSplit, cavity);
  sizeRows = distributeBottlesToSizeRows(sizeRows, totalBottles);

  return res.status(200).json(
    generateResponse("Success", "FIFO preview", {
      fifoAllocations: fifoResult.allocations,
      totalBottlesSuggested: totalBottles,
      sizeRowsSuggested: sizeRows,
      availablePlants: stock.plants,
      availableBottles: stock.bottles,
    })
  );
});

const labToPrimaryInwardBulk = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;
  const {
    primaryInwardDate,
    pollyhouse,
    cavity,
    totalPlantsSown,
    sizeSplit,
    fifoAllocations: clientFifo,
    sizeRows,
    laboursLadies,
    laboursGents,
    remarks,
    numberOfLabTrays: clientLabTrays,
  } = req.body ?? {};

  const total = safeNonNegativeInt(totalPlantsSown, 0);
  const cavityN = Math.max(1, safeNonNegativeInt(cavity, 126));
  const ladies = safeNonNegativeInt(laboursLadies, 0);
  const gents = safeNonNegativeInt(laboursGents, 0);
  const laboursEngaged = ladies + gents;
  const numberOfLabTrays =
    clientLabTrays != null && clientLabTrays !== ""
      ? safeNonNegativeInt(clientLabTrays, 0)
      : total >= 1
        ? Math.max(1, Math.ceil(total / 126))
        : 0;

  if (
    !primaryInwardDate ||
    !pollyhouse ||
    total < 1 ||
    !sizeSplit ||
    !Array.isArray(clientFifo) ||
    !Array.isArray(sizeRows) ||
    laboursEngaged < 1
  ) {
    return next(
      new AppError(
        "Missing required fields: primaryInwardDate, pollyhouse, totalPlantsSown, sizeSplit, fifoAllocations, sizeRows, labours (ladies+gents ≥ 1)",
        400
      )
    );
  }

  const splitSum =
    safeNonNegativeInt(sizeSplit.R1, 0) +
    safeNonNegativeInt(sizeSplit.R2, 0) +
    safeNonNegativeInt(sizeSplit.R3, 0);
  if (splitSum !== total) {
    return next(
      new AppError(
        `sizeSplit must sum to totalPlantsSown (${total}). Got ${splitSum}`,
        400
      )
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const plantOutward = await PlantOutward.findOne({ batchId }).session(session);
    if (!plantOutward) {
      throw new AppError("No plant outward found with this batch ID", 404);
    }

    const pool = collectAcceptedLabPool(plantOutward);
    const rowBottleSum = sizeRows.reduce(
      (s, r) => s + safeNonNegativeInt(r.numberOfBottles, 0),
      0
    );
    const bottleCheck = validateBottlesForInward(pool, rowBottleSum);
    if (!bottleCheck.ok) {
      throw new AppError(bottleCheck.error, 400);
    }

    const fifoResult = allocateFifo(pool, total);
    if (!fifoResult.ok) {
      throw new AppError(fifoResult.error, 400);
    }

    const fifoBottles = fifoResult.allocations.reduce(
      (s, a) => s + safeNonNegativeInt(a.bottlesTaken, 0),
      0
    );
    if (rowBottleSum < fifoBottles) {
      throw new AppError(
        `Size rows total ${rowBottleSum} bottles but FIFO needs at least ${fifoBottles}`,
        400
      );
    }

    if (!fifoAllocationsMatch(clientFifo, fifoResult.allocations)) {
      throw new AppError(
        "FIFO allocation is stale; refresh preview and try again",
        409
      );
    }

    const fifoAllocations = fifoResult.allocations;
    const primaryFifoLabId = fifoAllocations[0]?.labEntryId ?? null;

    const plantReadyCountdown = await buildPlantReadyMeta(batchId);
    let primaryOutwardExpectedDate;
    if (plantReadyCountdown.hasAnchor && plantReadyCountdown.primaryStageReadyAt) {
      primaryOutwardExpectedDate = new Date(plantReadyCountdown.primaryStageReadyAt);
    } else {
      const pd = Number(safeMongooseNumber(plantReadyCountdown.primaryPlantReadyDays)) || 0;
      const m = moment(primaryInwardDate);
      if (pd > 0 && m.isValid()) {
        primaryOutwardExpectedDate = m.clone().startOf("day").add(pd, "days").toDate();
      }
    }

    const inwardSessionId = new mongoose.Types.ObjectId();

    for (const alloc of fifoAllocations) {
      const labEntry = plantOutward.outward.id(alloc.labEntryId);
      if (!labEntry) {
        throw new AppError(`Lab entry ${alloc.labEntryId} not found`, 404);
      }
      if (!isLabAcceptedFifo(labEntry)) {
        throw new AppError("Lab line must be accepted before inward", 403);
      }

      const stock = computeLabLineStockFifo(labEntry);
      if (alloc.plantsTaken > stock.plantsRemaining) {
        throw new AppError(
          `Plants exceed remaining on lab line ${alloc.labEntryId}`,
          400
        );
      }
      if (alloc.bottlesTaken > stock.bottlesRemaining) {
        throw new AppError(
          `Bottles exceed remaining on lab line ${alloc.labEntryId}`,
          400
        );
      }

      labEntry.transferHistory.push({
        transferDate: primaryInwardDate,
        bottlesTransferred: alloc.bottlesTaken,
        plantsTransferred: alloc.plantsTaken,
        remarks: remarks || "",
      });

      const newPlants = safeSubtractNonNegative(stock.plantsRemaining, alloc.plantsTaken);
      const newBottles = safeSubtractNonNegative(stock.bottlesRemaining, alloc.bottlesTaken);
      labEntry.availablePlants = clampUintForDb(newPlants);
      labEntry.availableBottles = clampUintForDb(newBottles);
      labEntry.transferStatus =
        newPlants === 0 && newBottles === 0
          ? "fully_transferred"
          : "partially_transferred";
    }

    const createdIds = [];
    for (const row of sizeRows) {
      const size = row.size;
      if (!["R1", "R2", "R3"].includes(size)) continue;
      const plants = safeNonNegativeInt(sizeSplit[size], 0);
      if (plants < 1) continue;

      const traysN = safeNonNegativeInt(row.numberOfTrays, 0);
      const numBottles = safeNonNegativeInt(row.numberOfBottles, 0);
      if (traysN < 1 || numBottles < 1) {
        throw new AppError(`Invalid trays/bottles for size ${size}`, 400);
      }

      const calculatedTotalQuantity = plants;
      if (traysN * cavityN < plants) {
        throw new AppError(
          `Trays × cavity (${traysN * cavityN}) is less than plants for ${size} (${plants})`,
          400
        );
      }

      const entry = {
        primaryInwardDate,
        numberOfBottles: numBottles,
        size,
        cavity: cavityN,
        numberOfTrays: traysN,
        ...(numberOfLabTrays > 0 && { numberOfLabTrays }),
        totalQuantity: plants,
        availableQuantity: plants,
        pollyhouse,
        laboursEngaged,
        laboursLadies: ladies,
        laboursGents: gents,
        transferStatus: "available",
        sourceLabId: primaryFifoLabId,
        inwardSessionId,
        remarks: remarks || undefined,
        ...(primaryOutwardExpectedDate && { primaryOutwardExpectedDate }),
      };

      plantOutward.primaryInward.push(entry);
      const pushed = plantOutward.primaryInward[plantOutward.primaryInward.length - 1];
      createdIds.push(String(pushed._id));
    }

    if (createdIds.length === 0) {
      throw new AppError("At least one size row with plants > 0 is required", 400);
    }

    await plantOutward.save({ session, validateModifiedOnly: true });
    await session.commitTransaction();

    return res.status(200).json(
      generateResponse("Success", "Bulk primary inward recorded", {
        inwardSessionId: String(inwardSessionId),
        primaryInwardIds: createdIds,
        fifoAllocations,
        plantReadyCountdown,
      })
    );
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});

/** Same effective ready date as primary mobile UI (stored → sowing anchor → inward+batch days). */
const resolveEffectivePrimaryOutwardExpectedMoment = (pi, plantReadyMeta = null) => {
  if (pi?.readinessBypassAt != null && moment(pi.readinessBypassAt).isValid()) {
    return moment(pi.readinessBypassAt).startOf("day");
  }
  if (
    pi?.primaryOutwardExpectedDate != null &&
    moment(pi.primaryOutwardExpectedDate).isValid()
  ) {
    return moment(pi.primaryOutwardExpectedDate).startOf("day");
  }
  if (
    plantReadyMeta?.primaryStageReadyAt != null &&
    moment(plantReadyMeta.primaryStageReadyAt).isValid()
  ) {
    return moment(plantReadyMeta.primaryStageReadyAt).startOf("day");
  }
  const pd = Number(plantReadyMeta?.primaryPlantReadyDays) || 0;
  if (pd > 0 && pi?.primaryInwardDate != null && moment(pi.primaryInwardDate).isValid()) {
    return moment(pi.primaryInwardDate).startOf("day").add(pd, "days");
  }
  return null;
};

/** Primary inward eligible for outward move (calendar ready, overdue, or manual bypass). */
const isPrimaryInwardOutwardEligible = (
  pi,
  today = moment().startOf("day"),
  plantReadyMeta = null,
) => {
  const bypassAt = pi?.readinessBypassAt;
  if (bypassAt != null && moment(bypassAt).isValid()) return true;

  const avail = safeNonNegativeInt(pi?.availableQuantity, 0);
  if (avail < 1) return false;

  const expected = resolveEffectivePrimaryOutwardExpectedMoment(pi, plantReadyMeta);
  if (!expected || !expected.isValid()) return true;
  return !today.isBefore(expected);
};

const bottlesForPrimaryOutwardChunk = (pi, traysMoving, plantsMoving) => {
  const cavity = Math.max(1, safeNonNegativeInt(pi.cavity, 126));
  const trays = Math.max(1, safeNonNegativeInt(traysMoving, 0));
  const inwardTrays = Math.max(1, safeNonNegativeInt(pi.numberOfTrays, 1));
  const inwardBottles = Math.max(1, safeNonNegativeInt(pi.numberOfBottles, 1));
  const plants = Math.max(1, safeNonNegativeInt(plantsMoving, trays * cavity));
  const proportionalBottles =
    trays >= inwardTrays
      ? inwardBottles
      : Math.max(1, Math.ceil((trays / inwardTrays) * inwardBottles));
  return Math.max(proportionalBottles, plants);
};

/** PATCH readiness bypass on a primary inward line (primary mobile outward). */
const patchPrimaryInwardReadinessBypass = catchAsync(async (req, res, next) => {
  const { batchId, primaryInwardId } = req.params;
  const { reason, clear } = req.body || {};
  const userId = req.user?._id || req.user?.id;

  const plantOutward = await PlantOutward.findOne({ batchId });
  if (!plantOutward) {
    return next(new AppError("No plant outward found with this batch ID", 404));
  }

  const piSub = plantOutward.primaryInward.id(primaryInwardId);
  if (!piSub) {
    return next(new AppError("Primary inward entry not found", 404));
  }

  if (clear) {
    piSub.readinessBypassAt = null;
    piSub.readinessBypassBy = null;
    piSub.readinessBypassReason = "";
  } else {
    const bypassNow = new Date();
    piSub.readinessBypassAt = bypassNow;
    piSub.primaryOutwardExpectedDate = bypassNow;
    if (userId && mongoose.isValidObjectId(String(userId))) {
      piSub.readinessBypassBy = userId;
    }
    piSub.readinessBypassReason = String(reason ?? "").trim().slice(0, 500);
  }

  await plantOutward.save({ validateBeforeSave: true });

  const piObj =
    typeof piSub.toObject === "function" ? piSub.toObject() : { ...piSub };

  const plantReadyMeta = await buildPlantReadyMeta(batchId);

  return res.status(200).json(
    generateResponse("Success", clear ? "Bypass cleared" : "Readiness bypass set", {
      primaryInward: piObj,
      outwardEligible: isPrimaryInwardOutwardEligible(piObj, moment().startOf("day"), plantReadyMeta),
    })
  );
});

/** Batch FIFO: move total plants from primary inward lines to primary outward (no size picker). */
const primaryBatchInwardToPrimaryOutward = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;
  const {
    numberOfPlants: plantsRaw,
    primaryOutwardDate,
    pollyhouse,
    qualityOfDispatch,
    laboursLadies,
    laboursGents,
    remarks,
    isReceived,
  } = req.body ?? {};

  const totalPlants = safeNonNegativeInt(plantsRaw, 0);
  const ladies = safeNonNegativeInt(laboursLadies, 0);
  const gents = safeNonNegativeInt(laboursGents, 0);
  const laboursEngaged = ladies + gents;
  const remarksStr =
    remarks === undefined || remarks === null ? "" : String(remarks).trim();
  const receivedBool =
    isReceived === true ||
    isReceived === "true" ||
    isReceived === "yes" ||
    isReceived === 1 ||
    isReceived === "1";

  if (totalPlants < 1) {
    return next(new AppError("numberOfPlants must be at least 1", 400));
  }
  if (
    !primaryOutwardDate ||
    (typeof primaryOutwardDate === "string" && primaryOutwardDate.trim() === "")
  ) {
    return next(new AppError("primaryOutwardDate is required", 400));
  }
  if (!pollyhouse || String(pollyhouse).trim() === "") {
    return next(new AppError("pollyhouse is required", 400));
  }
  if (!qualityOfDispatch || String(qualityOfDispatch).trim() === "") {
    return next(new AppError("qualityOfDispatch is required", 400));
  }
  if (laboursEngaged < 1) {
    return next(new AppError("labours (ladies+gents) must be at least 1", 400));
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const plantOutward = await PlantOutward.findOne({ batchId }).session(session);
    if (!plantOutward) {
      throw new AppError("No plant outward found with this batch ID", 404);
    }

    const plantReadyMeta = await buildPlantReadyMeta(batchId);
    const today = moment().startOf("day");
    const pool = (plantOutward.primaryInward || [])
      .map((pi) => {
        const plain = typeof pi.toObject === "function" ? pi.toObject() : pi;
        return { doc: pi, plain };
      })
      .filter(({ plain }) => safeNonNegativeInt(plain.availableQuantity, 0) >= 1)
      .sort((a, b) => {
        const da = new Date(a.plain.primaryInwardDate || 0).getTime();
        const db = new Date(b.plain.primaryInwardDate || 0).getTime();
        return da - db;
      });

    let remaining = totalPlants;
    const plan = [];
    for (const entry of pool) {
      if (remaining < 1) break;
      const avail = safeNonNegativeInt(entry.plain.availableQuantity, 0);
      if (avail < 1) continue;
      if (!isPrimaryInwardOutwardEligible(entry.plain, today, plantReadyMeta)) {
        continue;
      }
      const take = Math.min(avail, remaining);
      if (take < 1) continue;
      plan.push({ entry, plants: take });
      remaining -= take;
    }

    if (plan.length === 0) {
      throw new AppError(
        "No outward-eligible primary inward stock for this batch (check plant ready or bypass)",
        400
      );
    }
    if (remaining > 0) {
      throw new AppError(
        `Not enough outward-eligible plants (need ${totalPlants}, can move ${totalPlants - remaining})`,
        400
      );
    }

    const created = [];
    const inwardMoves = [];

    for (const { entry, plants } of plan) {
      const pi = entry.doc;
      const piPlain = entry.plain;
      const piId = String(pi._id);
      const cavityNum = Math.max(1, safeNonNegativeInt(piPlain.cavity, 126));
      const traysNum = Math.max(1, Math.ceil(plants / cavityNum));
      const bottlesNum = bottlesForPrimaryOutwardChunk(piPlain, traysNum, plants);

      const plantsToTransfer = Math.min(
        plants,
        safeNonNegativeInt(pi.availableQuantity, 0),
        bottlesNum
      );
      if (plantsToTransfer < 1) {
        throw new AppError(`Invalid transfer for inward ${piId}`, 400);
      }

      try {
        plantOutward.validateTransfer("primaryInward", piId, plantsToTransfer);
      } catch (error) {
        throw new AppError(error.message, 400);
      }

      inwardMoves.push({
        pi,
        piPlain,
        piId,
        plantsToTransfer,
        bottlesNum,
        cavityNum,
      });
    }

    const firstPlain = inwardMoves[0]?.piPlain;
    if (!firstPlain) {
      throw new AppError("No inward allocations produced", 400);
    }

    const totalTransferred = inwardMoves.reduce((s, m) => s + m.plantsToTransfer, 0);
    const totalBottles = inwardMoves.reduce((s, m) => s + m.bottlesNum, 0);
    const cavityNum = Math.max(1, safeNonNegativeInt(firstPlain.cavity, 126));
    const traysNum = Math.max(1, Math.ceil(totalTransferred / cavityNum));
    const dateOfPlantation = firstPlain.primaryInwardDate || primaryOutwardDate;
    const plantedM = moment(dateOfPlantation);
    const outwardM = moment(primaryOutwardDate);
    const daysTaken =
      plantedM.isValid() && outwardM.isValid()
        ? Math.max(0, outwardM.startOf("day").diff(plantedM.startOf("day"), "days"))
        : 0;

    for (const move of inwardMoves) {
      const transferHistory = {
        transferDate: primaryOutwardDate,
        quantityTransferred: move.plantsToTransfer,
        remarks: remarksStr || "Primary outward (batch)",
      };
      move.pi.transferHistory = move.pi.transferHistory || [];
      move.pi.transferHistory.push(transferHistory);
      const newAvail =
        safeNonNegativeInt(move.pi.availableQuantity, 0) - move.plantsToTransfer;
      move.pi.availableQuantity = Math.max(0, newAvail);
      move.pi.transferStatus =
        newAvail === 0 ? "fully_transferred" : "partially_transferred";
    }

    const primaryOutwardEntry = {
      primaryOutwardDate,
      numberOfBottles: Math.max(1, totalBottles),
      size: firstPlain.size,
      cavity: cavityNum,
      numberOfTrays: traysNum,
      totalQuantity: totalTransferred,
      numberOfPlants: totalTransferred,
      availableQuantity: totalTransferred,
      pollyhouse: String(pollyhouse).trim(),
      laboursEngaged,
      transferStatus: "available",
      remarks: remarksStr,
      qualityOfDispatch: String(qualityOfDispatch).trim(),
      isReceived: receivedBool,
      dateOfPlantation,
      numberOfDaysTaken: daysTaken,
      secondaryAcknowledgedAt: null,
    };

    plantOutward.primaryOutward.push(primaryOutwardEntry);
    const pushed =
      plantOutward.primaryOutward[plantOutward.primaryOutward.length - 1];
    for (const move of inwardMoves) {
      created.push({
        primaryInwardId: move.piId,
        primaryOutwardId: String(pushed._id),
        plants: move.plantsToTransfer,
        size: move.piPlain.size,
      });
    }

    await plantOutward.save({ session, validateModifiedOnly: true });
    await session.commitTransaction();

    return res.status(200).json(
      generateResponse("Success", "Batch primary outward recorded", {
        batchId,
        numberOfPlants: totalPlants,
        allocations: created,
      })
    );
  } catch (error) {
    await session.abortTransaction();
    return next(error);
  } finally {
    session.endSession();
  }
});

const primaryInwardToPrimaryOutward = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;
  const {
    primaryInwardId,  // Added this as source
    primaryOutwardDate,
    numberOfBottles,
    size,
    cavity,
    numberOfTrays,
    pollyhouse,
    laboursEngaged,
    remarks,
    qualityOfDispatch,
    isReceived,
    dateOfPlantation,
    numberOfDaysTaken
  } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const bottlesNum = Number(numberOfBottles);
    const cavityNum = Number(cavity);
    const traysNum = Number(numberOfTrays);
    const laboursNum = Number(laboursEngaged);
    const daysTakenNum =
      numberOfDaysTaken === undefined || numberOfDaysTaken === null || numberOfDaysTaken === ""
        ? NaN
        : Number(numberOfDaysTaken);
    const remarksStr =
      remarks === undefined || remarks === null ? "" : String(remarks).trim();
    const receivedBool =
      isReceived === true ||
      isReceived === "true" ||
      isReceived === "yes" ||
      isReceived === 1 ||
      isReceived === "1";

    /**
     * POST body requirements for primaryInward-to-primaryOutward:
     * - primaryInwardId (Mongo id string), primaryOutwardDate, dateOfPlantation (non-empty date strings or ISO)
     * - size: R1 | R2 | R3
     * - pollyhouse: non-empty string
     * - qualityOfDispatch: non-empty string
     * - numberOfBottles, cavity, numberOfTrays, laboursEngaged: numbers ≥ 1
     * - numberOfDaysTaken: number ≥ 0 (0 is valid — same calendar day)
     * - remarks / isReceived optional
     */
    const issues = [];
    if (!primaryInwardId || String(primaryInwardId).trim() === "")
      issues.push("primaryInwardId");
    if (
      primaryOutwardDate == null ||
      primaryOutwardDate === "" ||
      (typeof primaryOutwardDate === "string" && primaryOutwardDate.trim() === "")
    )
      issues.push("primaryOutwardDate");
    if (size == null || String(size).trim() === "") issues.push("size");
    if (
      pollyhouse === undefined ||
      pollyhouse === null ||
      String(pollyhouse).trim() === ""
    )
      issues.push("pollyhouse");
    if (
      qualityOfDispatch === undefined ||
      qualityOfDispatch === null ||
      String(qualityOfDispatch).trim() === ""
    )
      issues.push("qualityOfDispatch");
    if (
      dateOfPlantation == null ||
      dateOfPlantation === "" ||
      (typeof dateOfPlantation === "string" && dateOfPlantation.trim() === "")
    )
      issues.push("dateOfPlantation");
    if (Number.isNaN(bottlesNum) || bottlesNum < 1) issues.push("numberOfBottles (≥1)");
    if (Number.isNaN(cavityNum) || cavityNum < 1) issues.push("cavity (≥1)");
    if (Number.isNaN(traysNum) || traysNum < 1) issues.push("numberOfTrays (≥1)");
    if (Number.isNaN(laboursNum) || laboursNum < 1) issues.push("laboursEngaged (≥1)");
    if (Number.isNaN(daysTakenNum) || daysTakenNum < 0)
      issues.push("numberOfDaysTaken (≥0, number — 0 allowed)");
    if (issues.length) {
      throw new AppError(
        `Invalid primary outward payload: ${issues.join("; ")}`,
        400
      );
    }

    const plantOutward = await PlantOutward.findOne({ batchId }).session(session);
    if (!plantOutward) {
      throw new AppError("No plant outward found with this batch ID", 404);
    }

    // Find and validate primary inward entry
    const primaryInward = plantOutward.primaryInward.id(primaryInwardId);
    if (!primaryInward) {
      throw new AppError("Primary inward entry not found", 404);
    }

    const piPlain =
      typeof primaryInward.toObject === "function"
        ? primaryInward.toObject()
        : primaryInward;
    const plantReadyMeta = await buildPlantReadyMeta(batchId);
    if (!isPrimaryInwardOutwardEligible(piPlain, moment().startOf("day"), plantReadyMeta)) {
      throw new AppError(
        "Plants not ready for outward — wait for calendar date or set readiness bypass",
        400
      );
    }

    const rawPlants = cavityNum * traysNum;
    const plantsToTransfer = Math.min(
      rawPlants,
      safeNonNegativeInt(primaryInward.availableQuantity),
      bottlesNum
    );

    if (plantsToTransfer < 1) {
      throw new AppError(
        "Plants to transfer must be at least 1 (check cavity × trays, available stock, and quantity).",
        400
      );
    }

    // Validate transfer
    try {
      plantOutward.validateTransfer('primaryInward', primaryInwardId, plantsToTransfer);
    } catch (error) {
      throw new AppError(error.message, 400);
    }

    // Create transfer history for primary inward
    const transferHistory = {
      transferDate: primaryOutwardDate,
      quantityTransferred: plantsToTransfer,
      remarks: remarksStr || "Primary outward",
    };

    // Create primary outward entry
    const primaryOutwardEntry = {
      primaryOutwardDate,
      numberOfBottles: bottlesNum,
      size,
      cavity: cavityNum,
      numberOfTrays: traysNum,
      totalQuantity: plantsToTransfer,
      numberOfPlants: plantsToTransfer,
      availableQuantity: plantsToTransfer,
      pollyhouse: String(pollyhouse).trim(),
      laboursEngaged: laboursNum,
      transferStatus: 'available',
      remarks: remarksStr,
      qualityOfDispatch: String(qualityOfDispatch).trim(),
      isReceived: receivedBool,
      dateOfPlantation,
      numberOfDaysTaken: daysTakenNum,
      secondaryAcknowledgedAt: null,
    };

    const newPrimaryInwardStatus = 
      primaryInward.availableQuantity - plantsToTransfer === 0 ? 
      'fully_transferred' : 'partially_transferred';

    const updatedDoc = await PlantOutward.findOneAndUpdate(
      { batchId, "primaryInward._id": primaryInwardId },
      {
        $push: {
          primaryOutward: primaryOutwardEntry,
          "primaryInward.$.transferHistory": transferHistory
        },
        $set: {
          "primaryInward.$.transferStatus": newPrimaryInwardStatus,
          "primaryInward.$.availableQuantity": primaryInward.availableQuantity - plantsToTransfer
        }
      },
      { new: true, session, runValidators: true }
    );

    await session.commitTransaction();

    const response = generateResponse(
      "Success",
      "Transfer from primary inward to outward completed successfully",
      updatedDoc
    );

    res.status(200).json(response);
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});

/** Secondary Accept tab — acknowledge primary outward line before recording secondary inward (no stock movement). */
const acknowledgePrimaryOutwardForSecondary = catchAsync(async (req, res, next) => {
  const { batchId, primaryOutwardId } = req.params;
  const userId = req.user?._id || req.user?.id;

  const plantOutward = await PlantOutward.findOne({ batchId });
  if (!plantOutward) {
    return next(new AppError("No plant outward found with this batch ID", 404));
  }

  const primaryOutward = plantOutward.primaryOutward.id(primaryOutwardId);
  if (!primaryOutward) {
    return next(new AppError("Primary outward entry not found", 404));
  }

  const avail = safeNonNegativeInt(
    safeMongooseNumber(
      primaryOutward.availableQuantity ?? primaryOutward.totalQuantity
    ),
    0
  );
  if (avail < 1 || (primaryOutward.transferStatus ?? "available") === "fully_transferred") {
    return next(new AppError("No stock available to acknowledge", 400));
  }

  if (primaryOutward.secondaryAcknowledgedAt) {
    return res.status(200).json(
      generateResponse("Success", "Already acknowledged", {
        batchId: String(batchId),
        primaryOutwardId: String(primaryOutwardId),
        secondaryAcknowledgedAt: primaryOutward.secondaryAcknowledgedAt,
      })
    );
  }

  const now = new Date();
  const setDoc = {
    "primaryOutward.$.secondaryAcknowledgedAt": now,
  };
  if (userId && mongoose.isValidObjectId(String(userId))) {
    setDoc["primaryOutward.$.secondaryAcknowledgedBy"] = userId;
  }

  const updated = await PlantOutward.findOneAndUpdate(
    { batchId, "primaryOutward._id": primaryOutwardId },
    { $set: setDoc },
    { new: true, runValidators: true }
  ).populate(BATCH_POPULATE);

  return res.status(200).json(
    generateResponse(
      "Success",
      "Secondary acknowledgement recorded",
      {
        batchId: String(batchId),
        primaryOutwardId: String(primaryOutwardId),
        secondaryAcknowledgedAt: now,
        plantOutward: updated,
      },
      undefined
    )
  );
});

/** Record mortality against remaining plants on a primary outward line (secondary ops). */
const recordSecondaryPrimaryOutwardMortality = catchAsync(async (req, res, next) => {
  const { batchId, primaryOutwardId } = req.params;
  const { quantity, remarks } = req.body;
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty < 1 || !Number.isInteger(qty)) {
    return next(new AppError("quantity must be a positive integer", 400));
  }

  const plantOutward = await PlantOutward.findOne({ batchId });
  if (!plantOutward) {
    return next(new AppError("No plant outward found with this batch ID", 404));
  }

  const primaryOutward = plantOutward.primaryOutward.id(primaryOutwardId);
  if (!primaryOutward) {
    return next(new AppError("Primary outward entry not found", 404));
  }

  const avail = safeNonNegativeInt(safeMongooseNumber(primaryOutward.availableQuantity), 0);
  if (qty > avail) {
    return next(new AppError(`Mortality cannot exceed remaining plants (${avail})`, 400));
  }

  const newAvail = avail - qty;
  const uid = req.user?._id || req.user?.id;
  const pushEntry = {
    quantity: qty,
    recordedAt: new Date(),
    remarks: String(remarks ?? "").trim(),
    ...(mongoose.isValidObjectId(String(uid)) ? { recordedBy: uid } : {}),
  };

  const updated = await PlantOutward.findOneAndUpdate(
    { batchId, "primaryOutward._id": primaryOutwardId },
    {
      $set: { "primaryOutward.$.availableQuantity": newAvail },
      $push: { "primaryOutward.$.secondaryMortalityLog": pushEntry },
    },
    { new: true, runValidators: true }
  ).populate(BATCH_POPULATE);

  if (!updated) {
    return next(new AppError("Failed to record mortality", 400));
  }

  return res.status(200).json(generateResponse("Success", "Mortality recorded", updated, undefined));
});

/** Mark secondary sowing finished for this line — only when no plants remain on the line. */
const markSecondaryPrimaryOutwardSowingComplete = catchAsync(async (req, res, next) => {
  const { batchId, primaryOutwardId } = req.params;

  const plantOutward = await PlantOutward.findOne({ batchId });
  if (!plantOutward) {
    return next(new AppError("No plant outward found with this batch ID", 404));
  }

  const primaryOutward = plantOutward.primaryOutward.id(primaryOutwardId);
  if (!primaryOutward) {
    return next(new AppError("Primary outward entry not found", 404));
  }

  const avail = safeNonNegativeInt(safeMongooseNumber(primaryOutward.availableQuantity), 0);
  if (avail > 0) {
    return next(
      new AppError(
        "Sowing complete only when no plants remain — sow, transfer, or record mortality first",
        400
      )
    );
  }

  const updated = await PlantOutward.findOneAndUpdate(
    { batchId, "primaryOutward._id": primaryOutwardId },
    { $set: { "primaryOutward.$.secondarySowingCompletedAt": new Date() } },
    { new: true, runValidators: true }
  ).populate(BATCH_POPULATE);

  if (!updated) {
    return next(new AppError("Failed to update", 400));
  }

  return res.status(200).json(generateResponse("Success", "Sowing marked complete", updated, undefined));
});

const primaryToSecondaryInward = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;
  const {
    primaryOutwardId,  // Added source ID
    secondaryInwardDate,
    numberOfBottles: bottlesRaw,
    size,
    cavity: cavityRaw,
    numberOfTrays: traysRaw,
    pollyhouse,
    laboursEngaged: laboursRaw,
    laboursLadies,
    laboursGents,
    remarks,
    dateOfDispatch
  } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const traysNum = safeNonNegativeInt(traysRaw, 0);
    const cavityNum = Math.max(1, safeNonNegativeInt(cavityRaw, 126));
    const ladies = safeNonNegativeInt(laboursLadies, 0);
    const gents = safeNonNegativeInt(laboursGents, 0);
    const laboursEngaged =
      ladies + gents > 0 ? ladies + gents : safeNonNegativeInt(laboursRaw, 0);

    if (
      !primaryOutwardId ||
      !secondaryInwardDate ||
      !size ||
      traysNum < 1 ||
      !pollyhouse ||
      !dateOfDispatch ||
      laboursEngaged < 1
    ) {
      throw new AppError(
        "Missing required fields: primaryOutwardId, secondaryInwardDate, size, numberOfTrays (≥1), pollyhouse, dateOfDispatch, labours (≥1)",
        400
      );
    }

    const plantOutward = await PlantOutward.findOne({ batchId }).session(session);
    if (!plantOutward) {
      throw new AppError("No plant outward found with this batch ID", 404);
    }

    // Find and validate primary outward entry
    const primaryOutward = plantOutward.primaryOutward.id(primaryOutwardId);
    if (!primaryOutward) {
      throw new AppError("Primary outward entry not found", 404);
    }

    const outwardTrays = Math.max(1, safeNonNegativeInt(primaryOutward.numberOfTrays, 1));
    const outwardBottles = Math.max(1, safeNonNegativeInt(primaryOutward.numberOfBottles, 1));
    let bottlesNum = safeNonNegativeInt(bottlesRaw, 0);
    if (bottlesNum < 1) {
      bottlesNum =
        traysNum >= outwardTrays
          ? outwardBottles
          : Math.max(1, Math.ceil((traysNum / outwardTrays) * outwardBottles));
    }

    const calculatedTotalQuantity = cavityNum * traysNum;

    const batchDocForReady = await DispatchBatch.findById(batchId)
      .select(BATCH_SELECT_FIELDS)
      .session(session)
      .lean();
    const secondaryDaysForReady = batchDocForReady
      ? Number(safeMongooseNumber(batchDocForReady.secondaryPlantReadyDays)) || 0
      : 0;
    const inwardMoment = moment(secondaryInwardDate).startOf("day");
    const expectedReadyDate =
      inwardMoment.isValid() && secondaryDaysForReady >= 0
        ? inwardMoment.clone().add(secondaryDaysForReady, "days").toDate()
        : null;

    // Validate transfer
    try {
      plantOutward.validateTransfer('primaryOutward', primaryOutwardId, calculatedTotalQuantity);
    } catch (error) {
      throw new AppError(error.message, 400);
    }

    // Create transfer history for primary outward
    const transferHistory = {
      transferDate: secondaryInwardDate,
      quantityTransferred: calculatedTotalQuantity,
      remarks
    };

    // Create secondary inward entry
    const secondaryInwardEntry = {
      secondaryInwardDate,
      numberOfBottles: bottlesNum,
      size,
      cavity: cavityNum,
      numberOfTrays: traysNum,
      totalQuantity: calculatedTotalQuantity,
      availableQuantity: calculatedTotalQuantity,
      pollyhouse,
      laboursEngaged,
      transferStatus: 'available',
      sourcePrimaryOutwardId: primaryOutwardId,
      dateOfDispatch,
      remarks: remarks || undefined,
      ...(expectedReadyDate ? { expectedReadyDate } : {}),
    };

    const newPrimaryOutwardStatus = 
      primaryOutward.availableQuantity - calculatedTotalQuantity === 0 ? 
      'fully_transferred' : 'partially_transferred';

    const updatedDoc = await PlantOutward.findOneAndUpdate(
      { batchId, "primaryOutward._id": primaryOutwardId },
      {
        $push: {
          secondaryInward: secondaryInwardEntry,
          "primaryOutward.$.transferHistory": transferHistory
        },
        $set: {
          "primaryOutward.$.transferStatus": newPrimaryOutwardStatus,
          "primaryOutward.$.availableQuantity": primaryOutward.availableQuantity - calculatedTotalQuantity
        }
      },
      { new: true, session, runValidators: true }
    );

    const sis = updatedDoc?.secondaryInward || [];
    const newSi = sis[sis.length - 1];
    if (!newSi?._id) {
      throw new AppError("Could not resolve new secondary inward id for availability ledger", 500);
    }

    const performedBy = req.user?._id || req.user?.id;
    await recordSecondaryInwardOnLedger(session, {
      dispatchBatchId: batchId,
      plantOutwardId: updatedDoc._id,
      secondaryInwardId: newSi._id,
      secondaryInwardDate: newSi.secondaryInwardDate,
      plants: calculatedTotalQuantity,
      size: newSi.size,
      performedBy: mongoose.isValidObjectId(String(performedBy)) ? performedBy : undefined,
    });

    const siPlainNew =
      typeof newSi.toObject === "function" ? newSi.toObject() : { ...newSi };
    if (!siPlainNew.linkedBookingSlotId && expectedReadyDate && batchDocForReady) {
      const slotId = await resolveBookingSlotIdForSecondaryBatch(
        batchDocForReady,
        expectedReadyDate
      );
      if (slotId) {
        await PlantOutward.updateOne(
          { batchId, "secondaryInward._id": newSi._id },
          { $set: { "secondaryInward.$.linkedBookingSlotId": slotId } },
          { session }
        );
        siPlainNew.linkedBookingSlotId = slotId;
      }
    }
    if (siPlainNew.linkedBookingSlotId) {
      await recordShedActivity({
        batchId,
        stage: "secondary_inward",
        subdocId: newSi._id,
        action: SHED_ACTIVITY_ACTIONS.SECONDARY_SLOT_LINKED,
        activityName: `स्लॉट जोडला · ${moment(expectedReadyDate).format("DD MMM YYYY")}`,
        performedBy,
        quantity: calculatedTotalQuantity,
        newValue: {
          linkedBookingSlotId: siPlainNew.linkedBookingSlotId,
          expectedReadyDate,
        },
        session,
      });
    }
    try {
      const syncResult = await syncSecondaryInwardSlotStockAdd({
        session,
        batchId,
        secondaryInwardId: newSi._id,
        batchLean: batchDocForReady,
        siPlain: siPlainNew,
        dispatchEligible: true,
        force: true,
        performedBy: mongoose.isValidObjectId(String(performedBy)) ? performedBy : undefined,
      });
      if (syncResult?.applied > 0) {
        await recordShedActivity({
          batchId,
          stage: "secondary_inward",
          subdocId: newSi._id,
          action: SHED_ACTIVITY_ACTIONS.SECONDARY_SLOT_SYNC,
          activityName: `स्लॉट स्टॉक +${syncResult.applied}`,
          performedBy,
          quantity: syncResult.applied,
          newValue: { slotId: syncResult.slotId },
          session,
        });
      }
    } catch (slotErr) {
      console.warn("[secondaryShedSlotStock] inward sync:", slotErr?.message || slotErr);
    }

    await session.commitTransaction();

    const response = generateResponse(
      "Success",
      "Transfer from primary outward to secondary inward completed successfully",
      updatedDoc
    );

    res.status(200).json(response);
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});

/** FIFO plant take from primary outward pool (secondary lagwad — size chosen at secondary level). */
const allocateFifoPlantsFromPrimaryOutwardPool = (pool, plantsNeeded) => {
  let remaining = Math.max(0, safeNonNegativeInt(plantsNeeded, 0));
  const allocations = [];
  for (const item of pool) {
    if (remaining < 1) break;
    const avail = safeNonNegativeInt(
      item.plain.availableQuantity ?? item.plain.totalQuantity,
      0
    );
    if (avail < 1) continue;
    const take = Math.min(avail, remaining);
    if (take < 1) continue;
    allocations.push({ item, plants: take });
    remaining -= take;
  }
  return { allocations, remaining };
};

/** Batch lagwad: primary outward → secondary inward with secondary-level R1/R2/R3 split. */
const secondaryBatchLagwadFromPrimaryOutward = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;
  const {
    sizeSplit,
    cavity: cavityRaw,
    secondaryInwardDate,
    dateOfDispatch,
    pollyhouse,
    laboursLadies,
    laboursGents,
    laboursEngaged: laboursRaw,
    remarks,
  } = req.body ?? {};

  const cavityNum = Math.max(1, safeNonNegativeInt(cavityRaw, 126));
  const ladies = safeNonNegativeInt(laboursLadies, 0);
  const gents = safeNonNegativeInt(laboursGents, 0);
  const laboursEngaged =
    ladies + gents > 0 ? ladies + gents : safeNonNegativeInt(laboursRaw, 0);
  const remarksStr =
    remarks === undefined || remarks === null ? "" : String(remarks).trim();

  const sizeRows = ["R1", "R2", "R3"]
    .map((size) => ({
      size,
      plants: safeNonNegativeInt(sizeSplit?.[size], 0),
    }))
    .filter((r) => r.plants > 0);

  const totalPlants = sizeRows.reduce((s, r) => s + r.plants, 0);
  const hasR3 = sizeRows.some((r) => r.size === "R3");
  const hasR1R2 = sizeRows.some((r) => r.size === "R1" || r.size === "R2");

  if (totalPlants < 1) {
    return next(new AppError("At least 1 plant required in size split", 400));
  }
  if (hasR3 && hasR1R2) {
    return next(new AppError("R3 cannot be mixed with R1/R2 in one lagwad session", 400));
  }
  if (
    !secondaryInwardDate ||
    !dateOfDispatch ||
    !pollyhouse ||
    String(pollyhouse).trim() === "" ||
    laboursEngaged < 1
  ) {
    return next(
      new AppError(
        "secondaryInwardDate, dateOfDispatch, pollyhouse, and labours (≥1) are required",
        400
      )
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const plantOutward = await PlantOutward.findOne({ batchId }).session(session);
    if (!plantOutward) {
      throw new AppError("No plant outward found with this batch ID", 404);
    }

    const pool = (plantOutward.primaryOutward || [])
      .map((po) => {
        const plain = typeof po.toObject === "function" ? po.toObject() : po;
        return { doc: po, plain };
      })
      .filter(
        ({ plain }) =>
          safeNonNegativeInt(plain.availableQuantity ?? plain.totalQuantity, 0) >= 1
      )
      .sort((a, b) => {
        const da = new Date(a.plain.primaryOutwardDate || 0).getTime();
        const db = new Date(b.plain.primaryOutwardDate || 0).getTime();
        return da - db;
      });

    const batchDocForReady = await DispatchBatch.findById(batchId)
      .select(BATCH_SELECT_FIELDS)
      .session(session)
      .lean();
    const secondaryDaysForReady = batchDocForReady
      ? Number(safeMongooseNumber(batchDocForReady.secondaryPlantReadyDays)) || 0
      : 0;
    const inwardMoment = moment(secondaryInwardDate).startOf("day");
    const expectedReadyDate =
      inwardMoment.isValid() && secondaryDaysForReady >= 0
        ? inwardMoment.clone().add(secondaryDaysForReady, "days").toDate()
        : null;

    const created = [];
    const performedBy = req.user?._id || req.user?.id;

    for (const sr of sizeRows) {
      const { allocations, remaining } = allocateFifoPlantsFromPrimaryOutwardPool(
        pool,
        sr.plants
      );
      if (remaining > 0) {
        throw new AppError(
          `Not enough primary outward stock for ${sr.size} (${sr.plants - remaining} of ${sr.plants} available)`,
          400
        );
      }

      const traysNum = Math.max(1, Math.ceil(sr.plants / cavityNum));
      const firstPlain = allocations[0]?.item?.plain;
      const outwardTrays = Math.max(1, safeNonNegativeInt(firstPlain?.numberOfTrays, 1));
      const outwardBottles = Math.max(1, safeNonNegativeInt(firstPlain?.numberOfBottles, 1));
      const bottlesNum =
        traysNum >= outwardTrays
          ? outwardBottles
          : Math.max(1, Math.ceil((traysNum / outwardTrays) * outwardBottles));

      for (const { item, plants } of allocations) {
        const pi = item.doc;
        const piId = String(pi._id);
        try {
          plantOutward.validateTransfer("primaryOutward", piId, plants);
        } catch (error) {
          throw new AppError(error.message, 400);
        }

        pi.transferHistory = pi.transferHistory || [];
        pi.transferHistory.push({
          transferDate: secondaryInwardDate,
          quantityTransferred: plants,
          remarks: remarksStr || `Secondary lagwad · ${sr.size}`,
        });
        const newAvail = safeNonNegativeInt(pi.availableQuantity, 0) - plants;
        pi.availableQuantity = Math.max(0, newAvail);
        pi.transferStatus =
          newAvail === 0 ? "fully_transferred" : "partially_transferred";

        item.plain.availableQuantity = pi.availableQuantity;
      }

      const secondaryInwardEntry = {
        secondaryInwardDate,
        numberOfBottles: bottlesNum,
        size: sr.size,
        cavity: cavityNum,
        numberOfTrays: traysNum,
        totalQuantity: sr.plants,
        availableQuantity: sr.plants,
        pollyhouse: String(pollyhouse).trim(),
        laboursEngaged,
        transferStatus: "available",
        sourcePrimaryOutwardId: allocations[0]?.item?.doc?._id ?? null,
        dateOfDispatch,
        remarks: remarksStr || `Lagwad · ${sr.size}`,
        ...(expectedReadyDate ? { expectedReadyDate } : {}),
      };

      plantOutward.secondaryInward.push(secondaryInwardEntry);
      const pushed =
        plantOutward.secondaryInward[plantOutward.secondaryInward.length - 1];
      created.push({
        size: sr.size,
        plants: sr.plants,
        secondaryInwardId: String(pushed._id),
      });
    }

    await plantOutward.save({ session, validateModifiedOnly: true });

    for (const row of created) {
      const siPlain =
        typeof plantOutward.secondaryInward.id(row.secondaryInwardId)?.toObject ===
        "function"
          ? plantOutward.secondaryInward.id(row.secondaryInwardId).toObject()
          : plantOutward.secondaryInward.id(row.secondaryInwardId);
      if (!siPlain) continue;

      await recordSecondaryInwardOnLedger(session, {
        dispatchBatchId: batchId,
        plantOutwardId: plantOutward._id,
        secondaryInwardId: row.secondaryInwardId,
        secondaryInwardDate: siPlain.secondaryInwardDate,
        plants: row.plants,
        size: row.size,
        performedBy: mongoose.isValidObjectId(String(performedBy)) ? performedBy : undefined,
      });

      if (!siPlain.linkedBookingSlotId && expectedReadyDate && batchDocForReady) {
        const slotId = await resolveBookingSlotIdForSecondaryBatch(
          batchDocForReady,
          expectedReadyDate
        );
        if (slotId) {
          await PlantOutward.updateOne(
            { batchId, "secondaryInward._id": row.secondaryInwardId },
            { $set: { "secondaryInward.$.linkedBookingSlotId": slotId } },
            { session }
          );
          siPlain.linkedBookingSlotId = slotId;
        }
      }
      await recordShedActivity({
        batchId,
        stage: "secondary_inward",
        subdocId: row.secondaryInwardId,
        action: SHED_ACTIVITY_ACTIONS.SECONDARY_LAGWAD_RECORDED,
        activityName: `लागवड नोंद · ${row.plants} रोप · ${row.size}`,
        performedBy,
        quantity: row.plants,
        newValue: {
          size: row.size,
          expectedReadyDate,
          pollyhouse: String(pollyhouse).trim(),
        },
        session,
      });
      if (siPlain.linkedBookingSlotId) {
        await recordShedActivity({
          batchId,
          stage: "secondary_inward",
          subdocId: row.secondaryInwardId,
          action: SHED_ACTIVITY_ACTIONS.SECONDARY_SLOT_LINKED,
          activityName: `स्लॉट जोडला · ${moment(expectedReadyDate).format("DD MMM YYYY")}`,
          performedBy,
          quantity: row.plants,
          newValue: {
            linkedBookingSlotId: siPlain.linkedBookingSlotId,
            expectedReadyDate,
          },
          session,
        });
      }
      try {
        const syncResult = await syncSecondaryInwardSlotStockAdd({
          session,
          batchId,
          secondaryInwardId: row.secondaryInwardId,
          batchLean: batchDocForReady,
          siPlain,
          dispatchEligible: true,
          force: true,
          performedBy: mongoose.isValidObjectId(String(performedBy))
            ? performedBy
            : undefined,
        });
        if (syncResult?.applied > 0) {
          await recordShedActivity({
            batchId,
            stage: "secondary_inward",
            subdocId: row.secondaryInwardId,
            action: SHED_ACTIVITY_ACTIONS.SECONDARY_SLOT_SYNC,
            activityName: `स्लॉट स्टॉक +${syncResult.applied}`,
            performedBy,
            quantity: syncResult.applied,
            newValue: { slotId: syncResult.slotId },
            session,
          });
        }
      } catch (slotErr) {
        console.warn("[secondaryShedSlotStock] batch lagwad sync:", slotErr?.message || slotErr);
      }
    }

    await session.commitTransaction();

    return res.status(200).json(
      generateResponse("Success", "Secondary lagwad recorded", {
        batchId: String(batchId),
        totalPlants,
        created,
      })
    );
  } catch (error) {
    await session.abortTransaction();
    return next(error);
  } finally {
    session.endSession();
  }
});

const secondaryInwardToSecondaryOutward = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;
  const {
    secondaryInwardId,
    secondaryOutwardDate,
    numberOfBottles,
    size,
    cavity,
    numberOfTrays,
    pollyhouse,
    laboursEngaged,
    remarks,
    linkedOrderId,
    linkedDispatchId,
    linkedDispatchPlantRowIndex,
    evidencePhotoUrls,
    dispatchFulfillmentSequence,
  } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    if (
      !secondaryInwardId ||
      numberOfBottles == null ||
      !size ||
      cavity == null ||
      numberOfTrays == null
    ) {
      throw new AppError(
        "Missing required fields for secondary outward (secondaryInwardId, numberOfBottles, size, cavity, numberOfTrays)",
        400
      );
    }

    const photoList = Array.isArray(evidencePhotoUrls)
      ? evidencePhotoUrls.filter((u) => typeof u === "string" && u.trim().length > 0)
      : [];

    let fulfillmentSeq = null;
    if (dispatchFulfillmentSequence != null && dispatchFulfillmentSequence !== "") {
      const n = Number(dispatchFulfillmentSequence);
      if (!Number.isFinite(n) || n < 1 || Math.floor(n) !== n) {
        throw new AppError("dispatchFulfillmentSequence must be a positive integer", 400);
      }
      fulfillmentSeq = n;
    }

    let linkedDispatchDoc = null;
    const dispatchPlantRowIdx = Math.max(
      0,
      Number(linkedDispatchPlantRowIndex ?? 0) || 0
    );
    if (linkedDispatchId != null && linkedDispatchId !== "") {
      if (!mongoose.isValidObjectId(String(linkedDispatchId))) {
        throw new AppError("linkedDispatchId must be a valid dispatch id", 400);
      }
      linkedDispatchDoc = await Dispatch.findById(linkedDispatchId).session(session);
      if (!linkedDispatchDoc || linkedDispatchDoc.isDeleted) {
        throw new AppError("Linked vehicle dispatch not found", 404);
      }
      if (!["PENDING", "IN_TRANSIT"].includes(linkedDispatchDoc.transportStatus)) {
        throw new AppError(
          "Vehicle dispatch must be PENDING or IN_TRANSIT to record shed pickup",
          400
        );
      }
      if (fulfillmentSeq == null) {
        throw new AppError(
          "dispatchFulfillmentSequence is required when recording vehicle-linked shed pickup",
          400
        );
      }
    }

    const plantOutward = await PlantOutward.findOne({ batchId }).session(session);
    if (!plantOutward) {
      throw new AppError("No plant outward found with this batch ID", 404);
    }

    const secondaryInward = plantOutward.secondaryInward.id(secondaryInwardId);
    if (!secondaryInward) {
      throw new AppError("Secondary inward entry not found", 404);
    }

    const batchDoc = await DispatchBatch.findById(plantOutward.batchId)
      .select(BATCH_SELECT_FIELDS)
      .session(session)
      .lean();
    const secondaryDaysForElig = batchDoc
      ? Number(safeMongooseNumber(batchDoc.secondaryPlantReadyDays)) || 0
      : 0;
    const siPlain =
      typeof secondaryInward.toObject === "function"
        ? secondaryInward.toObject()
        : secondaryInward;

    const resolvedPollyhouse =
      (typeof pollyhouse === "string" && pollyhouse.trim()) ||
      String(siPlain.pollyhouse || "").trim();
    if (!resolvedPollyhouse) {
      throw new AppError(
        "Polly house / shade is required — choose recording location or ensure the inward line has pollyhouse set",
        400
      );
    }
    let resolvedLabours =
      laboursEngaged != null && laboursEngaged !== ""
        ? Number(laboursEngaged)
        : 1;
    if (!Number.isFinite(resolvedLabours) || resolvedLabours < 1) {
      resolvedLabours = 1;
    }
    const resolvedOutDate = secondaryOutwardDate
      ? new Date(secondaryOutwardDate)
      : new Date();
    if (!Number.isFinite(resolvedOutDate.getTime())) {
      throw new AppError("Invalid secondary outward date", 400);
    }

    let linkedOrderDoc = null;
    if (linkedOrderId != null && String(linkedOrderId).trim() !== "") {
      if (!mongoose.isValidObjectId(String(linkedOrderId))) {
        throw new AppError("linkedOrderId must be a valid order id", 400);
      }
      linkedOrderDoc = await Order.findById(linkedOrderId).session(session);
      if (!linkedOrderDoc) {
        throw new AppError("Linked order not found", 404);
      }
    }

    const dispatchElig = computeSecondaryDispatchEligibility(
      siPlain,
      secondaryDaysForElig,
      moment().startOf("day")
    );

    let skipReadinessBecauseVehicle = false;
    if (linkedDispatchDoc) {
      const row = linkedDispatchDoc.plantsDetails?.[dispatchPlantRowIdx];
      if (row) {
        if (
          String(batchDoc?.plantCmsId) !== String(row.plantId) ||
          String(batchDoc?.plantSubtypeId) !== String(row.subTypeId)
        ) {
          throw new AppError(
            "Batch plant/subtype must match the vehicle dispatch plant row",
            400
          );
        }
      }
      skipReadinessBecauseVehicle = true;
    }

    if (!dispatchElig.dispatchEligible && !skipReadinessBecauseVehicle) {
      throw new AppError(
        "Stock is not ready for secondary dispatch yet — wait until the expected date or record a readiness bypass on Inward.",
        400
      );
    }

    const calculatedTotalQuantity = cavity * numberOfTrays;

    try {
      plantOutward.validateTransfer("secondaryInward", secondaryInwardId, calculatedTotalQuantity);
    } catch (error) {
      throw new AppError(error.message, 400);
    }

    if (!batchDoc?.plantCmsId || !batchDoc?.plantSubtypeId) {
      throw new AppError(
        "Dispatch batch must have plant CMS and subtype set before linking farmer orders",
        400
      );
    }

    if (linkedOrderDoc) {
      const orderOk =
        linkedOrderDoc.orderStatus === "READY_FOR_DISPATCH" ||
        linkedOrderDoc.orderStatus === "DISPATCH_PROCESS";
      if (!orderOk) {
        throw new AppError(
          "Order must be READY_FOR_DISPATCH or DISPATCH_PROCESS for secondary outward",
          400
        );
      }
      if (!orderMatchesDispatchBatch(linkedOrderDoc, batchDoc)) {
        throw new AppError(
          "Order plant/subtype does not match this dispatch batch",
          400
        );
      }

      const currentOrderRemaining = orderRemainingPlantsValue(linkedOrderDoc);
      if (calculatedTotalQuantity > currentOrderRemaining) {
        throw new AppError(
          `Secondary outward quantity (${calculatedTotalQuantity}) exceeds remaining plants (${currentOrderRemaining}) on the order`,
          400
        );
      }

      if (linkedDispatchDoc) {
        const onVehicle = unionDispatchOrderObjectIds(linkedDispatchDoc).some(
          (oid) => String(oid) === String(linkedOrderId)
        );
        if (!onVehicle) {
          throw new AppError("linkedOrderId must be on the linked vehicle dispatch", 400);
        }
        const row = linkedDispatchDoc.plantsDetails?.[dispatchPlantRowIdx];
        if (row) {
          if (
            String(linkedOrderDoc.plantName) !== String(row.plantId) ||
            String(linkedOrderDoc.plantSubtype) !== String(row.subTypeId)
          ) {
            throw new AppError(
              "Order plant/subtype does not match linked dispatch plant row",
              400
            );
          }
        }
      }
    }

    const orderLinkSnapshot =
      linkedOrderDoc != null ? buildSecondaryOrderLinkSnapshot(linkedOrderDoc, batchDoc) : undefined;

    const transferHistory = {
      transferDate: resolvedOutDate,
      quantityTransferred: calculatedTotalQuantity,
      remarks,
    };

    const secondaryOutwardEntry = {
      secondaryOutwardDate: resolvedOutDate,
      numberOfBottles,
      size,
      cavity,
      numberOfTrays,
      totalQuantity: calculatedTotalQuantity,
      availableQuantity: calculatedTotalQuantity,
      pollyhouse: resolvedPollyhouse,
      laboursEngaged: resolvedLabours,
      transferStatus: "available",
      sourceSecondaryInwardId: secondaryInwardId,
      ...(linkedOrderDoc != null && linkedOrderId
        ? {
            linkedOrderId,
            orderLinkSnapshot,
          }
        : {}),
      ...(linkedDispatchDoc && {
        linkedDispatchId: linkedDispatchDoc._id,
        linkedDispatchPlantRowIndex: dispatchPlantRowIdx,
        ...(fulfillmentSeq != null ? { dispatchFulfillmentSequence: fulfillmentSeq } : {}),
        dispatchFulfillmentSnapshot: {
          transportId: linkedDispatchDoc.transportId,
          driverName: linkedDispatchDoc.driverName,
          vehicleName: linkedDispatchDoc.vehicleName,
          vehicleNumber: linkedDispatchDoc.vehicleNumber,
        },
      }),
      ...(photoList.length > 0 ? { evidencePhotoUrls: photoList } : {}),
    };

    const newSecondaryInwardStatus =
      secondaryInward.availableQuantity - calculatedTotalQuantity === 0
        ? "fully_transferred"
        : "partially_transferred";

    const updatedDoc = await PlantOutward.findOneAndUpdate(
      { batchId, "secondaryInward._id": secondaryInwardId },
      {
        $push: {
          secondaryOutward: secondaryOutwardEntry,
          "secondaryInward.$.transferHistory": transferHistory,
        },
        $set: {
          "secondaryInward.$.transferStatus": newSecondaryInwardStatus,
          "secondaryInward.$.availableQuantity":
            secondaryInward.availableQuantity - calculatedTotalQuantity,
        },
      },
      { new: true, session, runValidators: true }
    );

    const outArr = updatedDoc?.secondaryOutward || [];
    const newSo = outArr[outArr.length - 1];
    if (!newSo?._id) {
      throw new AppError("Could not resolve new secondary outward id for availability ledger", 500);
    }

    const outPerformedBy = req.user?._id || req.user?.id;
    const performedByOid = mongoose.isValidObjectId(String(outPerformedBy))
      ? outPerformedBy
      : undefined;

    let syncApplied = 0;
    try {
      const syncResult = await syncSecondaryInwardSlotStockAdd({
        session,
        batchId,
        secondaryInwardId,
        batchLean: batchDoc,
        siPlain,
        dispatchEligible: dispatchElig.dispatchEligible,
        force: dispatchElig.dispatchEligible || skipReadinessBecauseVehicle,
        performedBy: performedByOid,
      });
      syncApplied = syncResult?.applied ?? 0;
      const siForSubtract = {
        ...siPlain,
        linkedBookingSlotId:
          syncResult?.slotId || siPlain.linkedBookingSlotId || null,
        slotStockSyncedPlants:
          (Number(siPlain.slotStockSyncedPlants) || 0) + syncApplied,
      };
      await subtractSecondaryInwardSlotStock({
        session,
        batchId,
        secondaryInwardId,
        batchLean: batchDoc,
        siPlain: siForSubtract,
        quantity: calculatedTotalQuantity,
        performedBy: performedByOid,
      });
    } catch (slotErr) {
      console.warn("[secondaryShedSlotStock] outward sync:", slotErr?.message || slotErr);
    }

    await recordSecondaryOutwardOnLedger(session, {
      dispatchBatchId: batchId,
      plantOutwardId: updatedDoc._id,
      secondaryInwardId,
      secondaryOutwardId: newSo._id,
      quantity: calculatedTotalQuantity,
      performedBy: performedByOid,
      metadata: {
        ...(linkedOrderDoc != null
          ? {
              orderId: linkedOrderId,
              orderNumber: linkedOrderDoc.orderId,
            }
          : {}),
        ...(linkedDispatchDoc && { dispatchId: linkedDispatchDoc._id }),
      },
    });

    if (linkedOrderDoc) {
      const currentOrderRemaining = orderRemainingPlantsValue(linkedOrderDoc);
      const newRemaining = currentOrderRemaining - calculatedTotalQuantity;
      let newOrderStatus = linkedOrderDoc.orderStatus;
      if (newRemaining === 0) {
        newOrderStatus = "DISPATCHED";
      } else if (newRemaining < currentOrderRemaining) {
        newOrderStatus = "DISPATCH_PROCESS";
      }

      const processedByRaw = req.user?._id || req.user?.id;
      const preAssignedSecondary = String(linkedOrderDoc?.deliveryChallanInvoiceNumber || "").trim();
      let official = null;
      let secondaryInvoiceLabel = preAssignedSecondary;
      if (newOrderStatus === "DISPATCHED" && newRemaining === 0) {
        official = await ensureOfficialDeliveryChallanForOrder(linkedOrderDoc, session);
      }
      if (official) {
        secondaryInvoiceLabel = official;
      } else if (!secondaryInvoiceLabel) {
        const [freshSec] = await allocateNextInvoiceNumbers(session, 1);
        secondaryInvoiceLabel = freshSec || "";
      }

      const dispatchHistoryEntry = {
        date: new Date(),
        quantity: calculatedTotalQuantity,
        remainingAfterDispatch: newRemaining,
        processedBy: mongoose.isValidObjectId(String(processedByRaw))
          ? processedByRaw
          : undefined,
        driverName: linkedDispatchDoc?.driverName || "",
        vehicleName: linkedDispatchDoc?.vehicleName || "",
        dispatchId: linkedDispatchDoc ? linkedDispatchDoc._id : undefined,
        source: "SECONDARY_SHED",
        secondaryOutwardId: newSo._id,
        plantOutwardId: updatedDoc._id,
        dispatchBatchId: plantOutward.batchId,
        productSnapshot: orderLinkSnapshot,
        ...(secondaryInvoiceLabel ? { invoiceNumber: secondaryInvoiceLabel } : {}),
      };

      const secondaryOrderSet = {
        remainingPlants: newRemaining,
        orderStatus: newOrderStatus,
      };
      if (official) {
        secondaryOrderSet.officialDeliveryChallanNumber = official;
      }
      if (!preAssignedSecondary && secondaryInvoiceLabel && !official) {
        secondaryOrderSet.deliveryChallanInvoiceNumber = secondaryInvoiceLabel;
      }

      await updateOrderWithLedgerSync({
        orderId: linkedOrderId,
        existingDoc: linkedOrderDoc,
        session,
        userId: processedByRaw,
        contextLabel: "secondary_shed_outward",
        updateOperation: {
          $set: secondaryOrderSet,
          $push: { dispatchHistory: dispatchHistoryEntry },
        },
      });
    }

    await session.commitTransaction();

    const response = generateResponse(
      "Success",
      "Transfer from secondary inward to secondary outward completed successfully",
      updatedDoc
    );

    res.status(200).json(response);
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});

/** Unified shed activity timeline for a batch. */
const getShedActivityByBatch = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;
  const events = await buildShedActivityTimeline(batchId);
  return res.status(200).json(
    generateResponse("Success", "Shed activity timeline", { batchId, events }, undefined)
  );
});

/** Activity for one secondary inward line. */
const getSecondaryInwardActivity = catchAsync(async (req, res, next) => {
  const { batchId, secondaryInwardId } = req.params;
  const events = await buildShedActivityTimeline(batchId, { secondaryInwardId });
  return res.status(200).json(
    generateResponse(
      "Success",
      "Secondary inward activity",
      { batchId, secondaryInwardId, events },
      undefined
    )
  );
});

// Updated getTransferHistory to include all stages
const getTransferHistory = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;
  const { stage, startDate, endDate } = req.query;

  const plantOutward = await PlantOutward.findOne({ batchId });
  if (!plantOutward) {
    throw new AppError("No plant outward found with this batch ID", 404);
  }

  let transfers = [];

  // Get lab to primary transfers
  if (!stage || stage === "lab") {
    const labTransfers = plantOutward.outward.flatMap(lab => 
      lab.transferHistory.map(t => ({
        ...t.toObject(),
        fromStage: "lab",
        toStage: "primary_inward",
        size: lab.size
      }))
    );
    transfers = [...transfers, ...labTransfers];
  }

  // Get primary inward to outward transfers
  if (!stage || stage === "primary_inward") {
    const primaryInwardTransfers = plantOutward.primaryInward.flatMap(primary => 
      primary.transferHistory.map(t => ({
        ...t.toObject(),
        fromStage: "primary_inward",
        toStage: "primary_outward",
        size: primary.size
      }))
    );
    transfers = [...transfers, ...primaryInwardTransfers];
  }

  // Get primary outward to secondary transfers
  if (!stage || stage === "primary_outward") {
    const primaryOutwardTransfers = plantOutward.primaryOutward.flatMap(primary => 
      primary.transferHistory.map(t => ({
        ...t.toObject(),
        fromStage: "primary_outward",
        toStage: "secondary_inward",
        size: primary.size
      }))
    );
    transfers = [...transfers, ...primaryOutwardTransfers];
  }

  // Get secondary inward to outward transfers
  if (!stage || stage === "secondary_inward") {
    const secondaryInwardTransfers = plantOutward.secondaryInward.flatMap(secondary => 
      secondary.transferHistory.map(t => ({
        ...t.toObject(),
        fromStage: "secondary_inward",
        toStage: "secondary_outward",
        size: secondary.size
      }))
    );
    transfers = [...transfers, ...secondaryInwardTransfers];
  }

  // Apply date filters if provided
  if (startDate && endDate) {
    transfers = transfers.filter(
      t => t.transferDate >= new Date(startDate) && 
           t.transferDate <= new Date(endDate)
    );
  }

  // Sort by date
  transfers.sort((a, b) => b.transferDate - a.transferDate);

  const response = generateResponse(
    "Success",
    "Transfer history retrieved successfully",
    transfers
  );

  res.status(200).json(response);
});

const getPrimaryInwards = catchAsync(async (req, res, next) => {
  const { batchId, startDate, endDate } = req.query;

  // Initialize query object
  const queryObj = {};

  // Add batchId filter if provided
  if (batchId) {
    queryObj.batchId = batchId;
  }

  // Add date range filter if provided
  if (startDate && endDate) {
    queryObj["primaryInward"] = {
      $elemMatch: {
        primaryInwardDate: {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        }
      }
    };
  }

  const plantOutwards = await PlantOutward.find(queryObj)
    .populate(BATCH_POPULATE)
    .select("primaryInward")
    .sort("-createdAt");

  // Extract only primaryInward data
  const primaryInwards = plantOutwards.flatMap(po => po.primaryInward);

  const response = generateResponse(
    "Success",
    "Primary inward entries retrieved successfully",
    primaryInwards,
    undefined
  );

  res.status(200).json(response);
});

/**
 * Paginated primary inward lines for mobile (one row per primary inward subdocument).
 * Query: filter=all|remaining|partial|complete, page (≥1), limit (1–100), optional batchId
 */
const getPrimaryInwardLinesPaginated = catchAsync(async (req, res, next) => {
  const rawFilter = String(req.query.filter || "all").toLowerCase();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const skip = (page - 1) * limit;

  const allowed = ["all", "remaining", "partial", "complete"];
  const f = allowed.includes(rawFilter) ? rawFilter : "all";

  const batchIdRaw = req.query.batchId;
  const batchObjectId =
    batchIdRaw && mongoose.Types.ObjectId.isValid(String(batchIdRaw))
      ? new mongoose.Types.ObjectId(String(batchIdRaw))
      : null;

  /** After $unwind primaryInward — filter by transfer stage */
  const transferMatch =
    f === "remaining"
      ? { "primaryInward.transferStatus": { $ne: "fully_transferred" } }
      : f === "partial"
        ? { "primaryInward.transferStatus": "partially_transferred" }
        : f === "complete"
          ? { "primaryInward.transferStatus": "fully_transferred" }
          : {};

  const batchColl = DispatchBatch.collection.collectionName;

  const pipeline = [
    {
      $match: {
        ...(batchObjectId ? { batchId: batchObjectId } : {}),
        primaryInward: { $exists: true, $type: "array", $not: { $size: 0 } },
      },
    },
    { $unwind: "$primaryInward" },
    ...(Object.keys(transferMatch).length ? [{ $match: transferMatch }] : []),
    {
      $sort: {
        "primaryInward.primaryInwardDate": -1,
        "primaryInward._id": -1,
      },
    },
    {
      $facet: {
        meta: [{ $count: "total" }],
        data: [
          { $skip: skip },
          { $limit: limit },
          {
            $lookup: {
              from: batchColl,
              localField: "batchId",
              foreignField: "_id",
              as: "_batchArr",
            },
          },
          {
            $replaceRoot: {
              newRoot: {
                $mergeObjects: [
                  "$primaryInward",
                  {
                    _batchId: "$batchId",
                    batchNumber: {
                      $arrayElemAt: ["$_batchArr.batchNumber", 0],
                    },
                    plantOutwardDocumentId: "$_id",
                  },
                ],
              },
            },
          },
        ],
      },
    },
  ];

  const agg = await PlantOutward.aggregate(pipeline).allowDiskUse(true);
  const facet = agg[0] || { meta: [], data: [] };
  const total = facet.meta[0]?.total ?? 0;
  const rows = facet.data || [];
  const hasMore = skip + rows.length < total;

  const response = generateResponse(
    "Success",
    "Primary inward lines",
    {
      rows,
      page,
      limit,
      total,
      hasMore,
    },
    undefined
  );

  res.status(200).json(response);
});

const getPrimaryOutwards = catchAsync(async (req, res, next) => {
  const { batchId, startDate, endDate, isReceived } = req.query;

  // Initialize query object
  const queryObj = {};

  // Add batchId filter if provided
  if (batchId) {
    queryObj.batchId = batchId;
  }

  // Add date range filter if provided
  if (startDate && endDate) {
    queryObj["primaryOutward"] = {
      $elemMatch: {
        primaryOutwardDate: {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        }
      }
    };
  }

  // Add isReceived filter if provided
  if (isReceived !== undefined) {
    queryObj["primaryOutward.isReceived"] = isReceived === 'true';
  }

  const plantOutwards = await PlantOutward.find(queryObj)
    .populate(BATCH_POPULATE)
    .select("primaryOutward")
    .sort("-createdAt");

  // Extract only primaryOutward data
  const primaryOutwards = plantOutwards.flatMap(po => po.primaryOutward);

  const response = generateResponse(
    "Success",
    "Primary outward entries retrieved successfully",
    primaryOutwards,
    undefined
  );

  res.status(200).json(response);
});

const getSecondaryInwards = catchAsync(async (req, res, next) => {
  const { batchId, startDate, endDate } = req.query;

  // Initialize query object
  const queryObj = {};

  // Add batchId filter if provided
  if (batchId) {
    queryObj.batchId = batchId;
  }

  // Add date range filter if provided
  if (startDate && endDate) {
    queryObj["secondaryInward"] = {
      $elemMatch: {
        secondaryInwardDate: {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        }
      }
    };
  }

  const plantOutwards = await PlantOutward.find(queryObj)
    .populate(BATCH_POPULATE)
    .select("secondaryInward")
    .sort("-createdAt");

  // Extract only secondaryInward data
  const secondaryInwards = plantOutwards.flatMap(po => po.secondaryInward);

  const response = generateResponse(
    "Success",
    "Secondary inward entries retrieved successfully",
    secondaryInwards,
    undefined
  );

  res.status(200).json(response);
});

const getSecondaryOutwards = catchAsync(async (req, res, next) => {
  const { batchId, startDate, endDate } = req.query;

  // Initialize query object
  const queryObj = {};

  // Add batchId filter if provided
  if (batchId) {
    queryObj.batchId = batchId;
  }

  // Add date range filter if provided
  if (startDate && endDate) {
    queryObj["secondaryOutward"] = {
      $elemMatch: {
        secondaryOutwardDate: {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        }
      }
    };
  }

  const plantOutwards = await PlantOutward.find(queryObj)
    .populate(BATCH_POPULATE)
    .select("secondaryOutward")
    .sort("-createdAt");

  // Extract only secondaryOutward data
  const secondaryOutwards = plantOutwards.flatMap(po => po.secondaryOutward);

  const response = generateResponse(
    "Success",
    "Secondary outward entries retrieved successfully",
    secondaryOutwards,
    undefined
  );

  res.status(200).json(response);
});

const getPrimaryInwardById = catchAsync(async (req, res, next) => {
  const { batchId, primaryInwardId } = req.params;

  const plantOutward = await PlantOutward.findOne({
    batchId,
    "primaryInward._id": primaryInwardId
  }).populate(BATCH_POPULATE);

  if (!plantOutward) {
    return next(new AppError("No plant outward found with this batch ID", 404));
  }

  const primaryInward = plantOutward.primaryInward.id(primaryInwardId);
  if (!primaryInward) {
    return next(new AppError("Primary inward entry not found", 404));
  }

  const response = generateResponse(
    "Success",
    "Primary inward entry retrieved successfully",
    primaryInward,
    undefined
  );

  res.status(200).json(response);
});

const getPrimaryOutwardById = catchAsync(async (req, res, next) => {
  const { batchId, primaryOutwardId } = req.params;

  const plantOutward = await PlantOutward.findOne({
    batchId,
    "primaryOutward._id": primaryOutwardId
  }).populate(BATCH_POPULATE);

  if (!plantOutward) {
    return next(new AppError("No plant outward found with this batch ID", 404));
  }

  const primaryOutward = plantOutward.primaryOutward.id(primaryOutwardId);
  if (!primaryOutward) {
    return next(new AppError("Primary outward entry not found", 404));
  }

  const response = generateResponse(
    "Success",
    "Primary outward entry retrieved successfully",
    primaryOutward,
    undefined
  );

  res.status(200).json(response);
});

const getSecondaryInwardById = catchAsync(async (req, res, next) => {
  const { batchId, secondaryInwardId } = req.params;

  const plantOutward = await PlantOutward.findOne({
    batchId,
    "secondaryInward._id": secondaryInwardId
  }).populate(BATCH_POPULATE);

  if (!plantOutward) {
    return next(new AppError("No plant outward found with this batch ID", 404));
  }

  const secondaryInward = plantOutward.secondaryInward.id(secondaryInwardId);
  if (!secondaryInward) {
    return next(new AppError("Secondary inward entry not found", 404));
  }

  const response = generateResponse(
    "Success",
    "Secondary inward entry retrieved successfully",
    secondaryInward,
    undefined
  );

  res.status(200).json(response);
});

/** All order ObjectIds tied to a dispatch (top-level list + per-line orderDispatchDetails). */
function unionDispatchOrderObjectIds(dispatchDoc) {
  const plain = dispatchDoc?.toObject?.() ?? dispatchDoc;
  const ids = new Set();
  for (const id of plain.orderIds || []) {
    if (id) ids.add(String(id));
  }
  for (const ord of plain.orderDispatchDetails || []) {
    if (ord?.orderId) ids.add(String(ord.orderId));
  }
  return [...ids]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
}

/** PENDING / IN_TRANSIT / LOADED vehicle dispatches for secondary shed fulfillment UI (paginated). */
const getSecondaryVehicleDispatches = catchAsync(async (req, res, next) => {
  const ALLOWED = DISPATCH_SHED_ALLOWED_STATUSES;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const qSearch = String(req.query.search || "").trim();

  const filter = {
    isDeleted: { $ne: true },
    transportStatus: { $in: ALLOWED },
  };
  if (qSearch) {
    filter.$or = [
      { transportId: new RegExp(qSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
      { driverName: new RegExp(qSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
      { vehicleName: new RegExp(qSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
    ];
  }

  const total = await Dispatch.countDocuments(filter);
  const docs = await Dispatch.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .select(
      "transportId transportStatus driverName driverMobile vehicleName vehicleNumber plantsDetails orderDispatchDetails orderIds createdAt updatedAt"
    )
    .lean();

  const previewOrderIdSet = new Set();
  for (const d of docs) {
    for (const ord of d.orderDispatchDetails || []) {
      if (ord.orderId && mongoose.isValidObjectId(String(ord.orderId))) {
        previewOrderIdSet.add(String(ord.orderId));
      }
    }
  }
  const previewOrderOids = [...previewOrderIdSet].map((id) => new mongoose.Types.ObjectId(id));
  const previewOrderLabels =
    previewOrderOids.length > 0
      ? await Order.find({ _id: { $in: previewOrderOids } })
          .select("_id orderId publicOrderCode")
          .lean()
      : [];
  const orderLabelById = new Map(previewOrderLabels.map((o) => [String(o._id), o]));

  const loadedByDispatch = await Promise.all(
    docs.map(async (d) => ({
      id: String(d._id),
      ...(await sumPlantsLoadedOnDispatch(d._id)),
    }))
  );
  const loadedMap = new Map(loadedByDispatch.map((x) => [x.id, x]));

  const plantIdSet = new Set();
  for (const d of docs) {
    for (const p of d.plantsDetails || []) {
      if (p.plantId && mongoose.isValidObjectId(String(p.plantId))) {
        plantIdSet.add(String(p.plantId));
      }
    }
  }
  const sowingAllowedByPlant = new Map();
  const plantCmsById = new Map();
  if (plantIdSet.size) {
    const cmsRows = await PlantCms.find({
      _id: { $in: [...plantIdSet].map((id) => new mongoose.Types.ObjectId(id)) },
    })
      .select("_id name sowingAllowed subtypes._id subtypes.name")
      .lean();
    for (const r of cmsRows) {
      sowingAllowedByPlant.set(String(r._id), Boolean(r.sowingAllowed));
      plantCmsById.set(String(r._id), r);
    }
  }

  const items = docs.map((d) => {
    let totalQty = 0;
    let plantRows = (d.plantsDetails || []).map((p, plantRowIndex) => {
      const q = Number(p.quantity ?? p.totalPlants ?? 0) || 0;
      totalQty += q;
      let cratePieces = 0;
      const crates = (p.crates || []).map((c) => {
        const crateCount = Number(c.crateCount || 0) || 0;
        cratePieces += crateCount;
        return {
          cavityName: String(c.cavityName || c.cavity || "").trim() || "—",
          crateCount,
          plantCount: Number(c.plantCount || 0) || 0,
        };
      });
      const pid = p.plantId ? String(p.plantId) : "";
      const sid = p.subTypeId ? String(p.subTypeId) : "";
      const cms = pid ? plantCmsById.get(pid) : null;
      const subtypeDoc = (cms?.subtypes || []).find((st) => String(st._id) === sid);
      const plantName = cms?.name || "";
      const subtypeName = subtypeDoc?.name || "";
      const label =
        plantName && subtypeName
          ? `${plantName} / ${subtypeName}`
          : String(p.name || "").trim() || plantName || subtypeName || "Plant";
      return {
        plantRowIndex,
        name: label,
        plantName: plantName || label,
        subtypeName: subtypeName || "",
        id: p.id,
        plantId: p.plantId,
        subTypeId: p.subTypeId,
        quantity: q,
        cratePieces,
        crates,
        sowingAllowed: pid ? Boolean(sowingAllowedByPlant.get(pid)) : false,
      };
    });

    const plantsDetailPreview = (d.plantsDetails || []).map((p) => {
      const q = Number(p.quantity ?? p.totalPlants ?? 0) || 0;
      const crates = (p.crates || []).map((c) => ({
        cavityName: String(c.cavityName || "").trim(),
        crateCount: Number(c.crateCount || 0) || 0,
        plantCount: Number(c.plantCount || 0) || 0,
      }));
      const shadeMap = new Map();
      for (const pd of p.pickupDetails || []) {
        const label = String(pd.shadeName || pd.shade || "").trim() || "—";
        const qty = Number(pd.quantity || 0) || 0;
        shadeMap.set(label, (shadeMap.get(label) || 0) + qty);
      }
      const pickupByShade = [...shadeMap.entries()].map(([shadeName, quantity]) => ({
        shadeName,
        quantity,
      }));
      return {
        name: p.name,
        quantity: q,
        crates,
        pickupByShade,
      };
    });

    const loadedInfo = loadedMap.get(String(d._id)) || { total: 0, byOrder: new Map() };

    const orderDispatchPreview = (d.orderDispatchDetails || []).map((row) => {
      const oid = String(row.orderId || "");
      const label = orderLabelById.get(oid);
      let lineCratePieces = 0;
      const crates = (row.crates || []).map((c) => {
        const cc = Number(c.crateCount || 0) || 0;
        lineCratePieces += cc;
        return {
          cavityName: String(c.cavityName || c.cavity || "").trim() || "—",
          crateCount: cc,
          plantCount: Number(c.plantCount || 0) || 0,
        };
      });
      const dispatchQuantity = Number(row.dispatchQuantity || 0) || 0;
      const fromOutward = loadedInfo.byOrder?.get(oid) || 0;
      const shedLoadedQuantity = Math.max(
        Number(row.shedLoadedQuantity) || 0,
        fromOutward
      );
      const shedLoadedFromSecondary = Boolean(
        row.shedLoadedFromSecondary || fromOutward > 0
      );
      return {
        orderId: row.orderId,
        orderIdNumeric: label?.orderId ?? null,
        publicOrderCode: label?.publicOrderCode ?? "",
        dispatchQuantity,
        shedLoadedQuantity,
        shedLoadedFromSecondary,
        isFullyLoadedFromShed:
          dispatchQuantity > 0 && shedLoadedQuantity >= dispatchQuantity,
        crates,
        cratePiecesOnLine: lineCratePieces,
      };
    });

    const odPlantTotal = orderDispatchPreview.reduce((s, r) => s + r.dispatchQuantity, 0);
    let odCratePieces = 0;
    for (const line of orderDispatchPreview) {
      odCratePieces += line.cratePiecesOnLine;
    }

    if (plantRows.length === 0 && odPlantTotal > 0) {
      plantRows = [
        {
          name: "Orders on vehicle (collection slip)",
          id: "orderLines",
          quantity: odPlantTotal,
          cratePieces: odCratePieces,
        },
      ];
      totalQty = odPlantTotal;
    }

    const unionCount = unionDispatchOrderObjectIds(d).length;
    const vehiclePlantQty = totalQty || odPlantTotal;
    const shedLoadedPlantsTotal = loadedInfo.total || 0;
    const loadProgressPct =
      vehiclePlantQty > 0
        ? Math.min(100, Math.round((shedLoadedPlantsTotal / vehiclePlantQty) * 100))
        : 0;

    return {
      _id: d._id,
      transportId: d.transportId,
      transportStatus: d.transportStatus,
      driverName: d.driverName,
      driverMobile: d.driverMobile,
      vehicleName: d.vehicleName,
      vehicleNumber: d.vehicleNumber,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      totalPlantQty: vehiclePlantQty,
      vehiclePlantQty,
      shedLoadedPlantsTotal,
      loadProgressPct,
      plantRowsSummary: plantRows,
      plantsDetailPreview,
      orderDispatchPreview,
      orderCount: unionCount || (d.orderIds || []).length,
    };
  });

  const response = generateResponse(
    "Success",
    "Vehicle dispatches for secondary ops",
    {
      items,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
    undefined
  );
  res.status(200).json(response);
});

/**
 * Crate breakdown for a plant-row need (mirrors dispatch.controller calculateDispatchCrates).
 * A full crate = cavitySize x numberPerCrate plants; remainder becomes one partial crate.
 */
const buildCrateInfo = (needPlants, cavitySize, numberPerCrate) => {
  const qty = Math.max(0, Math.floor(Number(needPlants) || 0));
  const cav = Math.max(0, Math.floor(Number(cavitySize) || 0));
  const per = Math.max(0, Math.floor(Number(numberPerCrate) || 0));
  const cratePlants = cav > 0 && per > 0 ? cav * per : 0;
  if (cratePlants < 1) {
    return {
      cavitySize: cav,
      numberPerCrate: per,
      cratePlants: 0,
      needPlants: qty,
      fullCrates: 0,
      partialPlants: qty,
      totalCrates: 0,
    };
  }
  const numberOfTrays = Math.floor(qty / cav);
  const fullCrates = Math.floor(numberOfTrays / per);
  const plantsInFull = fullCrates * cratePlants;
  const partialPlants = Math.max(0, qty - plantsInFull);
  const totalCrates = fullCrates + (partialPlants > 0 ? 1 : 0);
  return {
    cavitySize: cav,
    numberPerCrate: per,
    cratePlants,
    needPlants: qty,
    fullCrates,
    partialPlants,
    totalCrates,
  };
};

/**
 * Accurate crate NEED for a plant row that may span multiple cavities.
 * Prefers the row's already-computed `crates` (authoritative); else groups
 * pickupDetails by their Tray and sums per-cavity crate counts. Returns null
 * when neither is available (caller falls back to single-cavity math).
 */
const buildRowCrateNeed = async (row) => {
  if (Array.isArray(row?.crates) && row.crates.length) {
    const totalCrates = row.crates.reduce(
      (s, c) => s + Math.max(0, Math.floor(Number(c.crateCount) || 0)),
      0
    );
    if (totalCrates > 0) return totalCrates;
  }

  const pickups = Array.isArray(row?.pickupDetails) ? row.pickupDetails : [];
  const ids = [...new Set(pickups.map((p) => p.cavity).filter(Boolean).map(String))];
  if (!ids.length) return null;

  const trays = await Tray.find({ _id: { $in: ids } })
    .select("cavity numberPerCrate")
    .lean();
  const trayById = new Map(trays.map((t) => [String(t._id), t]));

  let totalCrates = 0;
  let any = false;
  for (const p of pickups) {
    const t = trayById.get(String(p.cavity));
    if (!t) continue;
    const info = buildCrateInfo(p.quantity, t.cavity, t.numberPerCrate);
    if (info.totalCrates > 0) {
      totalCrates += info.totalCrates;
      any = true;
    }
  }
  return any ? totalCrates : null;
};

/**
 * Resolve the single crate definition (cavitySize + numberPerCrate) for a dispatch plant row.
 * Prefers the row's pickup Tray; falls back to a Tray matching the first suggestion's cavity size.
 */
const resolveRowCrateDefinition = async (row, suggestions) => {
  let cavitySize = 0;
  let numberPerCrate = 0;

  const rowCavityId =
    Array.isArray(row?.pickupDetails) && row.pickupDetails[0]?.cavity
      ? row.pickupDetails[0].cavity
      : null;
  if (rowCavityId && mongoose.isValidObjectId(String(rowCavityId))) {
    const trayLean = await Tray.findById(rowCavityId)
      .select("cavity numberPerCrate")
      .lean();
    if (trayLean) {
      cavitySize = Number(trayLean.cavity) || 0;
      numberPerCrate = Number(trayLean.numberPerCrate) || 0;
    }
  }

  if (cavitySize < 1) {
    const firstCav = (suggestions || []).find((s) => Number(s.cavity) > 0)?.cavity;
    cavitySize = Math.max(0, Math.floor(Number(firstCav) || 0));
  }
  if (numberPerCrate < 1 && cavitySize > 0) {
    const trayByCav = await Tray.findOne({ cavity: cavitySize })
      .select("numberPerCrate")
      .lean();
    numberPerCrate = Number(trayByCav?.numberPerCrate) || 0;
  }

  return { cavitySize, numberPerCrate };
};

/**
 * FIFO-sorted secondary inward candidates for a dispatch plant row + matching orders on that vehicle.
 */
const getVehicleDispatchAllocationSuggestions = catchAsync(async (req, res, next) => {
  const { dispatchId } = req.params;
  const plantRowIndex = Math.max(
    0,
    Number(req.query.plantRowIndex ?? req.query.plantRow ?? 0) || 0
  );

  const dispatchDoc = await findDispatchActiveByIdOrTransport(dispatchId);
  if (!dispatchDoc) {
    return next(
      new AppError(
        "No active dispatch matches this id — use dispatch _id or transportId",
        404
      )
    );
  }

  let row = dispatchDoc.plantsDetails?.[plantRowIndex];
  if (!row) {
    const unionIds = unionDispatchOrderObjectIds(dispatchDoc);
    if (!unionIds.length) {
      return next(new AppError("Invalid plant row index for this dispatch (no plant rows and no orders)", 400));
    }
    const inferOrder = await Order.findById(unionIds[0]).select("plantName plantSubtype").lean();
    if (!inferOrder?.plantName || !inferOrder?.plantSubtype) {
      return next(
        new AppError("Cannot infer plant/subtype for this vehicle — add plant rows to the dispatch or fix orders", 400)
      );
    }
    const qtyFromDetails = (dispatchDoc.orderDispatchDetails || []).reduce(
      (s, r) => s + (Number(r.dispatchQuantity) || 0),
      0
    );
    const fallbackQty = qtyFromDetails || 1;
    row = {
      name: "Vehicle load",
      plantId: inferOrder.plantName,
      subTypeId: inferOrder.plantSubtype,
      quantity: fallbackQty,
      totalPlants: fallbackQty,
    };
  }

  const plantCmsId = row.plantId;
  const plantSubtypeId = row.subTypeId;
  if (!plantCmsId || !plantSubtypeId) {
    return next(new AppError("Dispatch plant row missing plant/subtype ids", 400));
  }

  const { suggestions: stripped, batchDocs } =
    await collectSecondaryInwardSuggestionsForPlantSubtype(plantCmsId, plantSubtypeId);

  const batches = batchDocs.map((b) => ({
    batchId: b._id,
    batchNumber: b.batchNumber ?? "",
  }));

  let suggestionsOut = stripped.map((s) => ({
    ...s,
    remainingPlants: s.remainingPlants ?? s.availableQuantity ?? 0,
  }));
  const batchIdRaw = req.query.batchId ?? req.query.batch;
  if (batchIdRaw != null && String(batchIdRaw).trim() !== "") {
    const bid = String(batchIdRaw).trim();
    if (mongoose.isValidObjectId(bid)) {
      suggestionsOut = suggestionsOut.filter((s) => String(s.batchId) === bid);
    }
  }

  const eligibleOnly =
    req.query.eligibleOnly === "true" || req.query.eligibleOnly === "1";
  if (eligibleOnly) {
    suggestionsOut = suggestionsOut.filter((s) => s.dispatchEligible);
  }

  const needPlants = Number(row.quantity ?? row.totalPlants ?? 0) || 0;

  // numberPerCrate per distinct inward cavity size (each entry converts crates with its own tray).
  const cavitySizes = [
    ...new Set(
      suggestionsOut.map((s) => Math.floor(Number(s.cavity) || 0)).filter((n) => n > 0)
    ),
  ];
  const perCrateByCavity = new Map();
  if (cavitySizes.length) {
    const trays = await Tray.find({ cavity: { $in: cavitySizes } })
      .select("cavity numberPerCrate")
      .lean();
    for (const t of trays) {
      const c = Math.floor(Number(t.cavity) || 0);
      const per = Math.max(0, Math.floor(Number(t.numberPerCrate) || 0));
      if (c > 0 && per > 0 && !perCrateByCavity.has(c)) perCrateByCavity.set(c, per);
    }
  }
  suggestionsOut = suggestionsOut.map((s) => {
    const c = Math.floor(Number(s.cavity) || 0);
    return { ...s, numberPerCrate: perCrateByCavity.get(c) || s.numberPerCrate || 0 };
  });

  // Crate NEED across (possibly mixed) cavities; single-cavity math is only a fallback.
  const { cavitySize, numberPerCrate } = await resolveRowCrateDefinition(
    row,
    suggestionsOut
  );
  const crateInfo = buildCrateInfo(needPlants, cavitySize, numberPerCrate);
  const mixedTotalCrates = await buildRowCrateNeed(row);
  if (mixedTotalCrates != null) {
    crateInfo.totalCrates = mixedTotalCrates;
    crateInfo.mixedCavity = true;
  }

  const suggestedFulfillmentSequence = await computeSuggestedFulfillmentSequence(
    dispatchDoc._id
  );

  const sowingAllowed = await isPlantSowingAllowed(plantCmsId);

  const rowPlantIds = [
    ...new Set(
      (dispatchDoc.plantsDetails || [])
        .map((pr) => (pr.plantId ? String(pr.plantId) : ""))
        .filter((id) => id && mongoose.isValidObjectId(id))
    ),
  ];
  const rowSowingMap = new Map();
  if (rowPlantIds.length) {
    const cmsRows = await PlantCms.find({
      _id: { $in: rowPlantIds.map((id) => new mongoose.Types.ObjectId(id)) },
    })
      .select("_id sowingAllowed")
      .lean();
    for (const r of cmsRows) {
      rowSowingMap.set(String(r._id), Boolean(r.sowingAllowed));
    }
  }

  const plantRows = (dispatchDoc.plantsDetails || []).map((pr, idx) => ({
    plantRowIndex: idx,
    name: pr.name,
    plantId: pr.plantId,
    subTypeId: pr.subTypeId,
    quantity: Number(pr.quantity ?? pr.totalPlants ?? 0) || 0,
    sowingAllowed: pr.plantId
      ? Boolean(rowSowingMap.get(String(pr.plantId)))
      : false,
  }));

  const unionIds = unionDispatchOrderObjectIds(dispatchDoc);
  const statusIn = { $in: ["READY_FOR_DISPATCH", "DISPATCH_PROCESS"] };

  const orderSelect = "_id orderId publicOrderCode remainingPlants orderStatus plantName plantSubtype";
  const orderPop = { path: "farmer", select: "name firstName lastName mobileNumber" };

  let matchingOrders = await Order.find({
    _id: { $in: unionIds },
    plantName: plantCmsId,
    plantSubtype: plantSubtypeId,
    remainingPlants: { $gt: 0 },
    orderStatus: statusIn,
  })
    .select(orderSelect)
    .populate(orderPop)
    .sort({ orderId: -1 })
    .limit(100)
    .lean();

  if (!matchingOrders.length && unionIds.length > 0) {
    matchingOrders = await Order.find({
      _id: { $in: unionIds },
      remainingPlants: { $gt: 0 },
      orderStatus: statusIn,
    })
      .select(orderSelect)
      .populate(orderPop)
      .sort({ orderId: -1 })
      .limit(100)
      .lean();
  }

  const response = generateResponse(
    "Success",
    "Allocation suggestions for vehicle dispatch plant row",
    {
      dispatchId: dispatchDoc._id,
      transportId: dispatchDoc.transportId,
      transportStatus: dispatchDoc.transportStatus,
      plantRowIndex,
      plantRowName: row.name,
      plantRowQuantity: needPlants,
      sowingAllowed,
      crateInfo,
      matchingOrders,
      suggestions: sowingAllowed ? [] : suggestionsOut,
      batches: sowingAllowed ? [] : batches,
      plantRows,
      suggestedFulfillmentSequence,
      otherBatchesWithSamePlant: sowingAllowed
        ? []
        : batchDocs.map((b) => b.batchNumber).filter(Boolean),
    },
    undefined
  );
  res.status(200).json(response);
});

/** GET sow-ready sellable slot entries (availablePlants > 0) for vehicle row, plantId+subtypeId, or all=1 date-wise. */
const getSowReadyEntries = catchAsync(async (req, res, next) => {
  const { dispatchId } = req.params;
  if (dispatchId) {
    const plantRowIndex = Math.max(
      0,
      Number(req.query.plantRowIndex ?? req.query.plantRow ?? 0) || 0
    );
    const data = await listSowReadyEntriesForDispatch(dispatchId, plantRowIndex);
    return res.status(200).json(
      generateResponse("Success", "Sow-ready entries for vehicle plant row", data, undefined)
    );
  }

  const wantAll =
    req.query.all === "1" ||
    req.query.all === "true" ||
    String(req.query.mode || "").toLowerCase() === "all";
  if (wantAll) {
    const data = await listAllSowReadyEntriesByDate();
    return res.status(200).json(
      generateResponse("Success", "All sow-ready entries date-wise", data, undefined)
    );
  }

  const plantId = req.query.plantId ?? req.query.plantCmsId;
  const subtypeId = req.query.subtypeId ?? req.query.plantSubtypeId ?? req.query.subTypeId;
  if (!plantId || !subtypeId) {
    return next(
      new AppError(
        "Query plantId and subtypeId required (or all=1 / vehicle-dispatch path)",
        400
      )
    );
  }
  const data = await listSowReadyEntries(plantId, subtypeId);
  return res.status(200).json(
    generateResponse("Success", "Sow-ready entries", { ...data, plantId, subtypeId }, undefined)
  );
});

/**
 * Live secondary shed stock for a pollyhouse (optional plant/subtype filter).
 */
const getSecondaryPolyhouseStock = catchAsync(async (req, res, next) => {
  const pollyhouse = String(req.query.pollyhouse ?? req.query.pollyHouse ?? "").trim();
  if (!pollyhouse) {
    return next(new AppError("Query pollyhouse is required", 400));
  }

  const plantCmsId = req.query.plantCmsId ?? req.query.plantName;
  const plantSubtypeId = req.query.plantSubtypeId ?? req.query.plantSubtype;
  const dispatchEligibleOnly =
    req.query.dispatchEligibleOnly !== "false" && req.query.dispatchEligibleOnly !== "0";

  if (plantCmsId && plantSubtypeId) {
    if (
      !mongoose.isValidObjectId(String(plantCmsId)) ||
      !mongoose.isValidObjectId(String(plantSubtypeId))
    ) {
      return next(new AppError("plantCmsId and plantSubtypeId must be valid ObjectIds", 400));
    }
  }

  let lines = await collectAllSecondaryInwardStockLines(
    plantCmsId && plantSubtypeId ? plantCmsId : null,
    plantCmsId && plantSubtypeId ? plantSubtypeId : null
  );

  lines = lines.filter((ln) => pollyhouseMatchesFilter(ln.pollyhouse, pollyhouse));

  if (dispatchEligibleOnly) {
    lines = lines.filter((ln) => ln.dispatchEligible);
  }

  const totalAvailablePlants = lines.reduce(
    (sum, ln) => sum + (Number(ln.availableQuantity) || 0),
    0
  );

  const byBatch = groupPolyhouseStockByBatch(lines);

  const response = generateResponse(
    "Success",
    "Secondary pollyhouse stock",
    {
      pollyhouse,
      totalAvailablePlants,
      lineCount: lines.length,
      byBatch,
      lines,
    },
    undefined
  );
  res.status(200).json(response);
});

/** POST FIFO preview for vehicle load from shed (no writes). */
const previewSecondaryVehicleLoadHandler = catchAsync(async (req, res, next) => {
  const { dispatchId } = req.params;
  const { pollyhouse, plants, plantRowIndex, shedLoads, inwardSelections } =
    req.body || {};
  const preview = await previewSecondaryVehicleLoad({
    dispatchId,
    pollyhouse,
    plants,
    shedLoads,
    inwardSelections,
    plantRowIndex,
    collectSuggestionsFn: collectSecondaryInwardSuggestionsForPlantSubtype,
  });
  return res.status(200).json(
    generateResponse("Success", "Vehicle load FIFO preview", preview, undefined)
  );
});

/** POST atomic FIFO vehicle load from secondary shed (or sow-ready slots). */
const postSecondaryVehicleLoad = catchAsync(async (req, res, next) => {
  const { dispatchId } = req.params;
  const {
    pollyhouse,
    plants,
    plantRowIndex,
    linkedOrderId,
    remarks,
    shedLoads,
    inwardSelections,
    sowReadySelections,
    source,
  } = req.body || {};
  const userId = req.user?._id || req.user?.id;
  const performedBy =
    userId && mongoose.isValidObjectId(String(userId)) ? userId : undefined;

  const sowSels = Array.isArray(sowReadySelections) ? sowReadySelections : [];
  const isSowReady =
    source === "SOW_READY" || sowSels.some((s) => s?.slotId && Number(s?.plants) > 0);

  if (isSowReady) {
    const result = await executeSowReadyVehicleLoad({
      dispatchId,
      plantRowIndex,
      sowReadySelections: sowSels,
      linkedOrderId,
      remarks,
      performedBy,
    });
    return res.status(200).json(
      generateResponse("Success", "Vehicle loaded from sow-ready slots", result, undefined)
    );
  }

  const result = await executeSecondaryVehicleLoad({
    dispatchId,
    pollyhouse,
    plants,
    shedLoads,
    inwardSelections,
    plantRowIndex,
    linkedOrderId,
    remarks,
    performedBy,
    collectSuggestionsFn: collectSecondaryInwardSuggestionsForPlantSubtype,
  });
  return res.status(200).json(
    generateResponse("Success", "Vehicle loaded from shed", result, undefined)
  );
});

/** GET outward lines already loaded on a vehicle (for unload / edit UI). */
const getSecondaryVehicleLoadedLines = catchAsync(async (req, res, next) => {
  const { dispatchId } = req.params;
  const linkedOrderId = req.query.linkedOrderId ?? req.query.orderId ?? null;

  const doc = await findDispatchActiveByIdOrTransport(dispatchId);
  if (!doc) {
    return next(new AppError("Vehicle dispatch not found", 404));
  }

  const { lines, totalPlants } = await collectLoadedOutwardLinesForDispatch(
    doc._id,
    linkedOrderId ? String(linkedOrderId) : undefined
  );

  const orderIds = [
    ...new Set(lines.map((l) => l.linkedOrderId).filter(Boolean)),
  ];
  const orderLabels =
    orderIds.length > 0
      ? await Order.find({ _id: { $in: orderIds } })
          .select("_id orderId publicOrderCode farmer")
          .populate("farmer", "name firstName lastName")
          .lean()
      : [];

  return res.status(200).json(
    generateResponse("Success", "Loaded outward lines for vehicle", {
      dispatchId: doc._id,
      transportId: doc.transportId,
      transportStatus: doc.transportStatus,
      linkedOrderId: linkedOrderId ? String(linkedOrderId) : null,
      lines,
      totalPlants,
      orders: orderLabels.map((o) => ({
        _id: o._id,
        orderId: o.orderId,
        publicOrderCode: o.publicOrderCode,
        farmer: o.farmer,
      })),
    })
  );
});

/** POST unload plants from vehicle back to source secondary inward / slot. */
const postSecondaryVehicleUnload = catchAsync(async (req, res, next) => {
  const { dispatchId } = req.params;
  const { linkedOrderId, outwardSelections, plantRowIndex } = req.body || {};
  const userId = req.user?._id || req.user?.id;
  const result = await executeSecondaryVehicleUnload({
    dispatchId,
    linkedOrderId,
    outwardSelections,
    plantRowIndex,
    performedBy:
      userId && mongoose.isValidObjectId(String(userId)) ? userId : undefined,
  });
  return res.status(200).json(
    generateResponse("Success", "Plants unloaded to secondary shed", result, undefined)
  );
});

/**
 * FIFO secondary inward lines for farmer dispatch shade picker — matches nursery `pollyhouse` to shade name/number.
 */
const getFarmerDispatchPickupBatchSuggestions = catchAsync(async (req, res, next) => {
  const plantCmsId = req.query.plantCmsId ?? req.query.plantName;
  const plantSubtypeId = req.query.plantSubtypeId ?? req.query.plantSubtype;
  if (!plantCmsId || !plantSubtypeId) {
    return next(new AppError("Query plantCmsId and plantSubtypeId are required", 400));
  }
  if (
    !mongoose.isValidObjectId(String(plantCmsId)) ||
    !mongoose.isValidObjectId(String(plantSubtypeId))
  ) {
    return next(new AppError("plantCmsId and plantSubtypeId must be valid ObjectIds", 400));
  }

  const shadeName = req.query.shadeName != null ? String(req.query.shadeName) : "";
  const shadeNumber = req.query.shadeNumber != null ? String(req.query.shadeNumber) : "";
  const trayCavityRaw = req.query.trayCavity;
  const trayCavity =
    trayCavityRaw != null && String(trayCavityRaw).trim() !== ""
      ? Number(trayCavityRaw)
      : null;

  const { suggestions: all, batchDocs } = await collectSecondaryInwardSuggestionsForPlantSubtype(
    plantCmsId,
    plantSubtypeId
  );

  let inShed = all;
  if (shadeName.trim() || shadeNumber.trim()) {
    inShed = all.filter((s) => shadeMatchesPollyhouse(s.pollyhouse, shadeName, shadeNumber));
  }

  let filtered = inShed;
  if (trayCavity != null && Number.isFinite(trayCavity) && trayCavity > 0) {
    const byCav = filtered.filter((s) => Number(s.cavity) === Number(trayCavity));
    if (byCav.length) filtered = byCav;
  }

  const firstReady = filtered.find((s) => s.dispatchEligible);
  const recommended = firstReady || filtered[0] || null;

  const response = generateResponse(
    "Success",
    "Pickup batch suggestions for farmer dispatch (shade + cavity)",
    {
      plantCmsId,
      plantSubtypeId,
      shadeName,
      shadeNumber,
      trayCavity: trayCavity != null && Number.isFinite(trayCavity) ? trayCavity : null,
      suggestions: filtered,
      recommended,
      otherBatchesWithSamePlant: batchDocs.map((b) => b.batchNumber).filter(Boolean),
    },
    undefined
  );
  res.status(200).json(response);
});

/**
 * Farmer orders READY_FOR_DISPATCH matching the batch plant/subtype (for secondary shed dispatch UI).
 */
const getSecondaryOrdersReadyForDispatch = catchAsync(async (req, res, next) => {
  const { batchId } = req.params;
  if (!mongoose.isValidObjectId(String(batchId))) {
    return next(new AppError("Invalid batch id", 400));
  }

  const batchDoc = await DispatchBatch.findById(batchId).select(BATCH_SELECT_FIELDS).lean();
  if (!batchDoc) {
    return next(new AppError("Dispatch batch not found", 404));
  }

  if (!batchDoc.plantCmsId || !batchDoc.plantSubtypeId) {
    const response = generateResponse(
      "Success",
      "Batch has no plant CMS / subtype — configure the batch to list matching orders",
      {
        orders: [],
        batchSummary: {
          batchNumber: batchDoc.batchNumber,
          plantConfigured: false,
        },
      },
      undefined
    );
    return res.status(200).json(response);
  }

  const orders = await Order.find({
    orderStatus: { $in: ["READY_FOR_DISPATCH", "DISPATCH_PROCESS"] },
    remainingPlants: { $gt: 0 },
    plantName: batchDoc.plantCmsId,
    plantSubtype: batchDoc.plantSubtypeId,
  })
    .select("_id orderId publicOrderCode remainingPlants orderStatus farmer")
    .populate("farmer", "name firstName lastName mobileNumber")
    .sort({ orderId: -1 })
    .limit(300)
    .lean();

  const response = generateResponse(
    "Success",
    "Orders ready for dispatch for this batch",
    {
      orders: orders.map((o) => ({
        _id: o._id,
        orderId: o.orderId,
        publicOrderCode: o.publicOrderCode,
        remainingPlants: o.remainingPlants,
        farmer: o.farmer,
      })),
      batchSummary: {
        batchNumber: batchDoc.batchNumber,
        plantConfigured: true,
        plantCmsId: batchDoc.plantCmsId,
        plantSubtypeId: batchDoc.plantSubtypeId,
      },
    },
    undefined
  );
  res.status(200).json(response);
});

const getSecondaryOutwardById = catchAsync(async (req, res, next) => {
  const { batchId, secondaryOutwardId } = req.params;

  const plantOutward = await PlantOutward.findOne({
    batchId,
    "secondaryOutward._id": secondaryOutwardId
  }).populate(BATCH_POPULATE);

  if (!plantOutward) {
    return next(new AppError("No plant outward found with this batch ID", 404));
  }

  const secondaryOutward = plantOutward.secondaryOutward.id(secondaryOutwardId);
  if (!secondaryOutward) {
    return next(new AppError("Secondary outward entry not found", 404));
  }

  const response = generateResponse(
    "Success",
    "Secondary outward entry retrieved successfully",
    secondaryOutward,
    undefined
  );

  res.status(200).json(response);
});

export {
  addLabEntry,
  updateLabEntry,
  patchLabReviewStatus,
  getPlantOutwardByBatchId,
  getPrimaryMobileDashboard,
  getSecondaryMobileDashboard,
  getAcceptedLabLines,
  getAllPlantOutwards,
  addPrimaryInward,
  updatePrimaryInward,
  deletePrimaryInward,
  getPrimaryInwardByBatchId,
  labToPrimaryInward,
  primaryInwardFifoPreview,
  primaryInwardFifoPreviewGlobal,
  labToPrimaryInwardBulk,
  labToPrimaryInwardBulkGlobal,
  primaryInwardToPrimaryOutward,
  primaryBatchInwardToPrimaryOutward,
  patchPrimaryInwardReadinessBypass,
  acknowledgePrimaryOutwardForSecondary,
  recordSecondaryPrimaryOutwardMortality,
  markSecondaryPrimaryOutwardSowingComplete,
  primaryToSecondaryInward,
  secondaryBatchLagwadFromPrimaryOutward,
  secondaryInwardToSecondaryOutward,
  getTransferHistory,
  getShedActivityByBatch,
  getSecondaryInwardActivity,
  getPrimaryInwards,
  getPrimaryInwardLinesPaginated,
  getPrimaryOutwards,
  getSecondaryInwards,
  getSecondaryOutwards,
  getPrimaryInwardById,
  getPrimaryOutwardById,
  getSecondaryInwardById,
  getSecondaryOutwardById,
  getSecondaryOrdersReadyForDispatch,
  getSecondaryVehicleDispatches,
  getVehicleDispatchAllocationSuggestions,
  getSowReadyEntries,
  getSecondaryPolyhouseStock,
  getFarmerDispatchPickupBatchSuggestions,
  patchSecondaryInwardReadinessBypass,
  previewSecondaryVehicleLoadHandler,
  postSecondaryVehicleLoad,
  getSecondaryVehicleLoadedLines,
  postSecondaryVehicleUnload,
};
