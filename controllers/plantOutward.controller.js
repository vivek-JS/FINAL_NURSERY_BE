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

const BATCH_PROJECTION =
  "batchNumber dateAdded primaryPlantReadyDays secondaryPlantReadyDays isActive";

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
    .select("batchNumber primaryPlantReadyDays secondaryPlantReadyDays")
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

  const plantOutward = await PlantOutward.findOne({ batchId });
  if (!plantOutward) {
    return next(new AppError("No plant outward found with that batch ID", 404));
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
  const query = PlantOutward.find(queryObj)
    .populate("batchId", BATCH_PROJECTION)
    .sort("-createdAt");

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

  const outward = await PlantOutward.findOne({ batchId }).populate(
    "batchId",
    BATCH_PROJECTION
  );

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
    .populate("batchId", BATCH_PROJECTION)
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
          .select(BATCH_PROJECTION)
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
        availableSecondaryInwardLines.push({
          plantOutwardId: po._id,
          batchId: resolvedBatchId,
          batchNumber: batchNum ?? String(resolvedBatchId),
          secondaryInward: si,
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
        });
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
      availableSecondaryInwardLines,
      plantReadyByBatchNumber,
      windowDays,
    },
    undefined
  );

  return res.status(200).json(response);
});

/** Dedicated list of accepted lab lines (same payload as dashboard.acceptedLabLines) */
const getAcceptedLabLines = catchAsync(async (req, res, next) => {
  const plantOutwards = await PlantOutward.find({})
    .populate("batchId", BATCH_PROJECTION)
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

  const outward = await PlantOutward.findOne({ batchId }).populate(
    "batchId",
    BATCH_PROJECTION
  );

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

    const plantReadyCountdown = await buildPlantReadyMeta(batchId);
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
    // Validate required fields
    if (!primaryInwardId || !primaryOutwardDate || !numberOfBottles || !size || !cavity || !numberOfTrays || !pollyhouse || !laboursEngaged || !remarks || !qualityOfDispatch || !isReceived || !dateOfPlantation || !numberOfDaysTaken) {
      throw new AppError("Missing required fields", 400);
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

    const calculatedTotalQuantity = cavity * numberOfTrays;

    // Validate transfer
    try {
      plantOutward.validateTransfer('primaryInward', primaryInwardId, calculatedTotalQuantity);
    } catch (error) {
      throw new AppError(error.message, 400);
    }

    // Create transfer history for primary inward
    const transferHistory = {
      transferDate: primaryOutwardDate,
      quantityTransferred: calculatedTotalQuantity,
      remarks
    };

    // Create primary outward entry
    const primaryOutwardEntry = {
      primaryOutwardDate,
      numberOfBottles,
      size,
      cavity,
      numberOfTrays,
      totalQuantity: calculatedTotalQuantity,
      availableQuantity: calculatedTotalQuantity,
      pollyhouse,
      laboursEngaged,
      transferStatus: 'available',
      remarks,
      qualityOfDispatch,
      isReceived,
      dateOfPlantation,
      numberOfDaysTaken
    };

    const newPrimaryInwardStatus = 
      primaryInward.availableQuantity - calculatedTotalQuantity === 0 ? 
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
          "primaryInward.$.availableQuantity": primaryInward.availableQuantity - calculatedTotalQuantity
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
    secondaryInwardId,  // Added source ID
    secondaryOutwardDate,
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
    if (!secondaryInwardId || !secondaryOutwardDate || !numberOfBottles || !size || !cavity || !numberOfTrays || !pollyhouse) {
      throw new AppError("Missing required fields", 400);
    }

    const plantOutward = await PlantOutward.findOne({ batchId }).session(session);
    if (!plantOutward) {
      throw new AppError("No plant outward found with this batch ID", 404);
    }

    // Find and validate secondary inward entry
    const secondaryInward = plantOutward.secondaryInward.id(secondaryInwardId);
    if (!secondaryInward) {
      throw new AppError("Secondary inward entry not found", 404);
    }

    const calculatedTotalQuantity = cavity * numberOfTrays;

    // Validate transfer
    try {
      plantOutward.validateTransfer('secondaryInward', secondaryInwardId, calculatedTotalQuantity);
    } catch (error) {
      throw new AppError(error.message, 400);
    }

    // Create transfer history for secondary inward
    const transferHistory = {
      transferDate: secondaryOutwardDate,
      quantityTransferred: calculatedTotalQuantity,
      remarks
    };

    // Create secondary outward entry
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
      transferStatus: 'available',
      sourceSecondaryInwardId: secondaryInwardId
    };

    const newSecondaryInwardStatus = 
      secondaryInward.availableQuantity - calculatedTotalQuantity === 0 ? 
      'fully_transferred' : 'partially_transferred';

    const updatedDoc = await PlantOutward.findOneAndUpdate(
      { batchId, "secondaryInward._id": secondaryInwardId },
      {
        $push: {
          secondaryOutward: secondaryOutwardEntry,
          "secondaryInward.$.transferHistory": transferHistory
        },
        $set: {
          "secondaryInward.$.transferStatus": newSecondaryInwardStatus,
          "secondaryInward.$.availableQuantity": secondaryInward.availableQuantity - calculatedTotalQuantity
        }
      },
      { new: true, session, runValidators: true }
    );

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
    .populate("batchId", BATCH_PROJECTION)
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
    .populate("batchId", BATCH_PROJECTION)
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
    .populate("batchId", BATCH_PROJECTION)
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
    .populate("batchId", BATCH_PROJECTION)
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
  }).populate("batchId", BATCH_PROJECTION);

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
  }).populate("batchId", BATCH_PROJECTION);

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
  }).populate("batchId", BATCH_PROJECTION);

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

const getSecondaryOutwardById = catchAsync(async (req, res, next) => {
  const { batchId, secondaryOutwardId } = req.params;

  const plantOutward = await PlantOutward.findOne({
    batchId,
    "secondaryOutward._id": secondaryOutwardId
  }).populate("batchId", BATCH_PROJECTION);

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
  primaryToSecondaryInward,
  secondaryInwardToSecondaryOutward,
  getTransferHistory,
  getPrimaryInwards,
  getPrimaryOutwards,
  getSecondaryInwards,
  getSecondaryOutwards,
  getPrimaryInwardById,
  getPrimaryOutwardById,
  getSecondaryInwardById,
  getSecondaryOutwardById
};
