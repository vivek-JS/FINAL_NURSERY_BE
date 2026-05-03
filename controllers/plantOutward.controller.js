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
  recordSecondaryInwardOnLedger,
  recordSecondaryOutwardOnLedger,
} from "../services/secondaryDispatchAvailability.service.js";
import Order from "../models/order.model.js";
import Dispatch from "../models/dispatch.model.js";
import { updateOrderWithLedgerSync } from "./dispatch.controller.js";

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
  return {
    bottlesTotal,
    plantsTotal,
    bottlesTransferred: transferredBottlesSoFar,
    plantsTransferred: transferredPlantsSoFar,
    bottlesRemaining: safeSubtractNonNegative(bottlesTotal, transferredBottlesSoFar),
    plantsRemaining: safeSubtractNonNegative(plantsTotal, transferredPlantsSoFar),
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

  const outwards = await query;

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
  const windowEnd = today.clone().add(windowDays, "days").endOf("day");

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

    for (const pi of po.primaryInward || []) {
      const expectedRaw = pi.primaryOutwardExpectedDate;
      const fallback = primaryStageReadyAt ? primaryStageReadyAt.toDate() : null;
      const expected = expectedRaw || fallback;
      if (!expected) continue;
      const expM = moment(expected);
      if (expM.isSameOrAfter(today) && expM.isSameOrBefore(windowEnd)) {
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
        safeMongooseNumber(pout.availableQuantity),
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
        safeMongooseNumber(si.availableQuantity),
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

  const dispatchReadyByBatch = buildDispatchReadyByBatch(
    availableSecondaryInwardLines
  );

  const response = generateResponse(
    "Success",
    "Secondary mobile dashboard",
    {
      incomingFromPrimary,
      upcomingSecondaryMilestones,
      upcomingSecondaryInwardExpected,
      upcomingSecondaryOutwardExpected,
      availableSecondaryInwardLines,
      dispatchReadyByBatch,
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

    if (clear) {
      siSub.readinessBypassAt = null;
      siSub.readinessBypassBy = null;
      siSub.readinessBypassReason = "";
    } else {
      siSub.readinessBypassAt = new Date();
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
    safeMongooseNumber(primaryOutward.availableQuantity),
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
    numberOfBottles,
    size,
    cavity,
    numberOfTrays,
    pollyhouse,
    laboursEngaged,
    remarks,
    dateOfDispatch
  } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Validate required fields
    if (!primaryOutwardId || !secondaryInwardDate || !numberOfBottles || !size || !cavity || !numberOfTrays || !pollyhouse || !dateOfDispatch) {
      throw new AppError("Missing required fields", 400);
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

    if (primaryOutward.secondaryAcknowledgedAt === null) {
      throw new AppError(
        "secondary_accept_required",
        400
      );
    }

    const calculatedTotalQuantity = cavity * numberOfTrays;

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
      numberOfBottles,
      size,
      cavity,
      numberOfTrays,
      totalQuantity: calculatedTotalQuantity,
      availableQuantity: calculatedTotalQuantity,
      pollyhouse,
      laboursEngaged,
      transferStatus: 'available',
      sourcePrimaryOutwardId: primaryOutwardId,
      dateOfDispatch
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
  } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    if (
      !secondaryInwardId ||
      !secondaryOutwardDate ||
      numberOfBottles == null ||
      !size ||
      cavity == null ||
      numberOfTrays == null ||
      !pollyhouse ||
      laboursEngaged == null ||
      !linkedOrderId
    ) {
      throw new AppError(
        "Missing required fields (including linkedOrderId for farmer order)",
        400
      );
    }
    if (!mongoose.isValidObjectId(String(linkedOrderId))) {
      throw new AppError("linkedOrderId must be a valid order id", 400);
    }

    const photoList = Array.isArray(evidencePhotoUrls)
      ? evidencePhotoUrls.filter((u) => typeof u === "string" && u.trim().length > 0)
      : [];

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
    const dispatchElig = computeSecondaryDispatchEligibility(
      siPlain,
      secondaryDaysForElig,
      moment().startOf("day")
    );

    let skipReadinessBecauseVehicle = false;
    if (linkedDispatchDoc) {
      const row = linkedDispatchDoc.plantsDetails?.[dispatchPlantRowIdx];
      if (!row) {
        throw new AppError("Invalid linkedDispatchPlantRowIndex for this dispatch", 400);
      }
      if (
        String(batchDoc?.plantCmsId) !== String(row.plantId) ||
        String(batchDoc?.plantSubtypeId) !== String(row.subTypeId)
      ) {
        throw new AppError(
          "Batch plant/subtype must match the vehicle dispatch plant row",
          400
        );
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

    const linkedOrderDoc = await Order.findById(linkedOrderId).session(session);
    if (!linkedOrderDoc) {
      throw new AppError("Linked order not found", 404);
    }

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
      const onVehicle = (linkedDispatchDoc.orderIds || []).some(
        (oid) => String(oid) === String(linkedOrderId)
      );
      if (!onVehicle) {
        throw new AppError("linkedOrderId must be on the linked vehicle dispatch", 400);
      }
      const row = linkedDispatchDoc.plantsDetails[dispatchPlantRowIdx];
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

    const orderLinkSnapshot = buildSecondaryOrderLinkSnapshot(linkedOrderDoc, batchDoc);

    const transferHistory = {
      transferDate: secondaryOutwardDate,
      quantityTransferred: calculatedTotalQuantity,
      remarks,
    };

    const secondaryOutwardEntry = {
      secondaryOutwardDate,
      numberOfBottles,
      size,
      cavity,
      numberOfTrays,
      totalQuantity: calculatedTotalQuantity,
      availableQuantity: calculatedTotalQuantity,
      pollyhouse,
      laboursEngaged,
      transferStatus: "available",
      sourceSecondaryInwardId: secondaryInwardId,
      linkedOrderId,
      orderLinkSnapshot,
      ...(linkedDispatchDoc && {
        linkedDispatchId: linkedDispatchDoc._id,
        linkedDispatchPlantRowIndex: dispatchPlantRowIdx,
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
    await recordSecondaryOutwardOnLedger(session, {
      dispatchBatchId: batchId,
      plantOutwardId: updatedDoc._id,
      secondaryInwardId,
      secondaryOutwardId: newSo._id,
      quantity: calculatedTotalQuantity,
      performedBy: mongoose.isValidObjectId(String(outPerformedBy)) ? outPerformedBy : undefined,
      metadata: {
        orderId: linkedOrderId,
        orderNumber: linkedOrderDoc.orderId,
        ...(linkedDispatchDoc && { dispatchId: linkedDispatchDoc._id }),
      },
    });

    const newRemaining = currentOrderRemaining - calculatedTotalQuantity;
    let newOrderStatus = linkedOrderDoc.orderStatus;
    if (newRemaining === 0) {
      newOrderStatus = "DISPATCHED";
    } else if (newRemaining < currentOrderRemaining) {
      newOrderStatus = "DISPATCH_PROCESS";
    }

    const processedByRaw = req.user?._id || req.user?.id;
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
    };

    await updateOrderWithLedgerSync({
      orderId: linkedOrderId,
      existingDoc: linkedOrderDoc,
      session,
      userId: processedByRaw,
      contextLabel: "secondary_shed_outward",
      updateOperation: {
        $set: {
          remainingPlants: newRemaining,
          orderStatus: newOrderStatus,
        },
        $push: { dispatchHistory: dispatchHistoryEntry },
      },
    });

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

async function findDispatchActiveByIdOrTransport(idParam) {
  const raw = String(idParam ?? "").trim();
  if (!raw) return null;
  if (mongoose.isValidObjectId(raw)) {
    const d = await Dispatch.findOne({ _id: raw, isDeleted: { $ne: true } });
    if (d) return d;
  }
  return Dispatch.findOne({ transportId: raw, isDeleted: { $ne: true } });
}

/** PENDING / IN_TRANSIT vehicle dispatches for secondary shed fulfillment UI (paginated). */
const getSecondaryVehicleDispatches = catchAsync(async (req, res, next) => {
  const ALLOWED = ["PENDING", "IN_TRANSIT"];
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

  const items = docs.map((d) => {
    let totalQty = 0;
    const plantRows = (d.plantsDetails || []).map((p) => {
      const q = Number(p.quantity ?? p.totalPlants ?? 0) || 0;
      totalQty += q;
      let cratePieces = 0;
      for (const c of p.crates || []) {
        cratePieces += Number(c.crateCount || 0) || 0;
      }
      return {
        name: p.name,
        id: p.id,
        quantity: q,
        cratePieces,
      };
    });
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
      totalPlantQty: totalQty,
      plantRowsSummary: plantRows,
      orderCount: (d.orderIds || []).length,
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

  const row = dispatchDoc.plantsDetails?.[plantRowIndex];
  if (!row) {
    return next(new AppError("Invalid plant row index for this dispatch", 400));
  }

  const plantCmsId = row.plantId;
  const plantSubtypeId = row.subTypeId;
  if (!plantCmsId || !plantSubtypeId) {
    return next(new AppError("Dispatch plant row missing plant/subtype ids", 400));
  }

  const batchDocs = await DispatchBatch.find({
    plantCmsId,
    plantSubtypeId,
    isActive: { $ne: false },
  })
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

      suggestions.push({
        batchId: po.batchId,
        batchNumber: batchLean.batchNumber,
        plantOutwardId: po._id,
        secondaryInwardId: si._id,
        availableQuantity: avail,
        dispatchEligible: elig.dispatchEligible,
        expectedReadyByCalendar: elig.expectedReadyByCalendar,
        secondaryInwardDate: siPlain.secondaryInwardDate,
        plantLabel: labels.plantLabel,
        subtypeLabel: labels.subtypeLabel,
        size: siPlain.size,
        cavity: siPlain.cavity,
        numberOfBottles: siPlain.numberOfBottles,
        numberOfTrays: siPlain.numberOfTrays,
        sortReady,
        sortInward,
      });
    }
  }

  suggestions.sort((a, b) => {
    if (a.sortReady !== b.sortReady) return a.sortReady - b.sortReady;
    return a.sortInward - b.sortInward;
  });

  const stripped = suggestions.map(
    ({ sortReady, sortInward, ...rest }) => rest
  );

  const oidSet = (dispatchDoc.orderIds || []).map((id) =>
    mongoose.isValidObjectId(id) ? id : null
  ).filter(Boolean);
  const matchingOrders = await Order.find({
    _id: { $in: oidSet },
    plantName: plantCmsId,
    plantSubtype: plantSubtypeId,
    remainingPlants: { $gt: 0 },
    orderStatus: { $in: ["READY_FOR_DISPATCH", "DISPATCH_PROCESS"] },
  })
    .select("_id orderId publicOrderCode remainingPlants orderStatus")
    .sort({ orderId: -1 })
    .limit(100)
    .lean();

  const response = generateResponse(
    "Success",
    "Allocation suggestions for vehicle dispatch plant row",
    {
      dispatchId: dispatchDoc._id,
      transportId: dispatchDoc.transportId,
      transportStatus: dispatchDoc.transportStatus,
      plantRowIndex,
      plantRowName: row.name,
      plantRowQuantity: Number(row.quantity ?? row.totalPlants ?? 0) || 0,
      matchingOrders,
      suggestions: stripped,
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
  primaryInwardToPrimaryOutward,
  acknowledgePrimaryOutwardForSecondary,
  recordSecondaryPrimaryOutwardMortality,
  markSecondaryPrimaryOutwardSowingComplete,
  primaryToSecondaryInward,
  secondaryInwardToSecondaryOutward,
  getTransferHistory,
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
  patchSecondaryInwardReadinessBypass,
};
