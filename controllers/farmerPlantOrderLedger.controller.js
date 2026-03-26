import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import Order from "../models/order.model.js";
import Farmer from "../models/farmer.model.js";
import FarmerPlantOrderLedgerEntry from "../models/farmerPlantOrderLedger.model.js";
import FarmerPlantOrderArchive from "../models/farmerPlantOrderArchive.model.js";
import {
  shouldLogFarmerPlantLedger,
  normalizeFarmerMobile,
  computeOrderPaymentTotals,
  sortLedgerEntriesCanonical,
  roundMoney,
} from "../utils/farmerPlantOrderLedgerHelper.js";

const DEBUG_ENDPOINT = "http://127.0.0.1:7242/ingest/44347468-0193-498c-9d04-ef8c3f7959e9";
const DEBUG_SESSION_ID = "69bde0";
const DEBUG_RUN_ID = "due-before-after-investigation";

function debugLog(hypothesisId, location, message, data = {}) {
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION_ID,
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      runId: DEBUG_RUN_ID,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

const orderDetailsPopulate = [
  { path: "farmer", select: "name village mobileNumber taluka district state" },
  { path: "plantName", select: "name" },
  { path: "salesPerson", select: "name phoneNumber jobTitle" },
  { path: "dealer", select: "name phoneNumber" },
  { path: "cavity", select: "cavity" },
];

function buildArchivedOrderPayload(archiveDoc) {
  const snap = archiveDoc.snapshot || {};
  return {
    ...snap,
    _id: archiveDoc.originalOrderId,
    orderId: snap.orderId ?? archiveDoc.orderId,
  };
}

/**
 * GET farmer plant ledger — summary + per-order rows + optional line entries.
 * Query: farmer (ObjectId), customerMobile, startDate, endDate, linesOnly (optional; "false" omits entries; default includes lines)
 */
export const getFarmerPlantLedger = catchAsync(async (req, res) => {
  const { farmer: farmerId, customerMobile, startDate, endDate, linesOnly } =
    req.query;

  /** Include line entries by default; pass linesOnly=false to omit (lighter payload). */
  const wantLineEntries =
    linesOnly !== "false" && linesOnly !== false && String(linesOnly) !== "0";

  if (!farmerId && !customerMobile) {
    return res.status(200).json(
      generateResponse(
        "Success",
        "Provide farmer (id) or customerMobile",
        {
          farmer: null,
          summary: {
            totalBilled: 0,
            totalCollected: 0,
            outstanding: 0,
            orderCount: 0,
          },
          orders: [],
          entries: [],
        },
        undefined
      )
    );
  }

  let farmerDoc = null;
  if (farmerId && mongoose.isValidObjectId(farmerId)) {
    farmerDoc = await Farmer.findById(farmerId).lean();
  }
  const mobileNorm = customerMobile
    ? normalizeFarmerMobile(customerMobile)
    : farmerDoc
      ? normalizeFarmerMobile(farmerDoc.mobileNumber)
      : null;

  if (!farmerDoc && mobileNorm) {
    const asNum = Number(mobileNorm);
    farmerDoc = await Farmer.findOne({ mobileNumber: asNum }).lean();
  }

  const farmerOid =
    farmerDoc?._id ||
    (farmerId && mongoose.isValidObjectId(farmerId)
      ? new mongoose.Types.ObjectId(farmerId)
      : null);

  const dateFilter = {};
  if (startDate) dateFilter.$gte = new Date(startDate);
  if (endDate) dateFilter.$lte = new Date(endDate + "T23:59:59.999Z");

  const orderQuery = {
    dealerOrder: false,
    ...(farmerOid ? { farmer: farmerOid } : {}),
  };
  if (Object.keys(dateFilter).length) {
    orderQuery.createdAt = dateFilter;
  }

  const orders = await Order.find(orderQuery)
    .populate("plantName", "name")
    .sort({ createdAt: -1 })
    .lean();

  const archives = farmerOid
    ? await FarmerPlantOrderArchive.find({
        "snapshot.farmer": farmerOid,
        ...(Object.keys(dateFilter).length ? { deletedAt: dateFilter } : {}),
      })
        .sort({ deletedAt: -1 })
        .lean()
    : [];

  let totalBilled = 0;
  let totalCollected = 0;
  const orderRows = [];

  for (const o of orders) {
    const { orderTotal, totalCollected: col, outstanding } =
      computeOrderPaymentTotals(o);
    totalBilled += orderTotal;
    totalCollected += col;
    orderRows.push({
      source: "ACTIVE",
      _id: o._id,
      orderId: o.orderId,
      plantName: o.plantName?.name || null,
      rate: o.rate,
      numberOfPlants: o.numberOfPlants,
      additionalPlants: o.additionalPlants || 0,
      totalPlants:
        (o.numberOfPlants || 0) + (o.additionalPlants || 0),
      orderTotal,
      totalCollected: col,
      outstanding,
      orderPaymentStatus: o.orderPaymentStatus,
      orderStatus: o.orderStatus,
      createdAt: o.createdAt,
      payment: o.payment,
    });
  }

  for (const ar of archives) {
    const snap = ar.snapshot || {};
    const fake = { ...snap, payment: snap.payment || [] };
    const { orderTotal, totalCollected: col, outstanding } =
      computeOrderPaymentTotals(fake);
    totalBilled += orderTotal;
    totalCollected += col;
    orderRows.push({
      source: "ARCHIVE",
      _id: ar.originalOrderId,
      orderId: snap.orderId ?? ar.orderId,
      plantName: snap.plantName?.name || snap.plantTitle || null,
      rate: snap.rate,
      numberOfPlants: snap.numberOfPlants,
      additionalPlants: snap.additionalPlants || 0,
      totalPlants:
        (snap.numberOfPlants || 0) + (snap.additionalPlants || 0),
      orderTotal,
      totalCollected: col,
      outstanding,
      orderPaymentStatus: snap.orderPaymentStatus,
      orderStatus: snap.orderStatus,
      createdAt: snap.createdAt,
      deletedAt: ar.deletedAt,
      payment: snap.payment,
    });
  }

  const outstandingTotal = Math.round((totalBilled - totalCollected) * 100) / 100;

  let entries = [];
  if (wantLineEntries) {
    const ledgerFilter = { customerMobile: mobileNorm || undefined };
    if (!ledgerFilter.customerMobile && farmerOid) {
      ledgerFilter.farmer = farmerOid;
    }
    if (!ledgerFilter.customerMobile && !ledgerFilter.farmer) {
      entries = [];
    } else {
      const clean = {};
      if (ledgerFilter.customerMobile) {
        clean.customerMobile = ledgerFilter.customerMobile;
      } else if (farmerOid) {
        clean.farmer = farmerOid;
      }

      let allEntries = await FarmerPlantOrderLedgerEntry.find(clean)
        .sort({ entryDate: 1 })
        .lean();

      const startDateObj = startDate ? new Date(startDate) : null;
      const endDateObj = endDate ? new Date(endDate + "T23:59:59.999Z") : null;

      const openingBalance = startDateObj
        ? allEntries
            .filter((e) => new Date(e.entryDate) < startDateObj)
            .reduce(
              (sum, e) => sum + (e.debit || 0) - (e.credit || 0),
              0
            )
        : 0;

      const entriesInRange = sortLedgerEntriesCanonical(
        allEntries.filter((entry) => {
          const d = new Date(entry.entryDate);
          if (startDateObj && d < startDateObj) return false;
          if (endDateObj && d > endDateObj) return false;
          return true;
        })
      );

      const allHaveStored =
        entriesInRange.length > 0 &&
        entriesInRange.every(
          (e) =>
            e.outstandingBefore != null &&
            e.outstandingAfter != null &&
            !Number.isNaN(Number(e.outstandingBefore)) &&
            !Number.isNaN(Number(e.outstandingAfter))
        );

      let running = roundMoney(openingBalance);
      entries = entriesInRange.map((entry) => {
        const net = roundMoney(
          (Number(entry.debit) || 0) - (Number(entry.credit) || 0)
        );
        let outstandingBefore;
        let outstandingAfter;
        let balance;
        if (allHaveStored) {
          outstandingBefore = roundMoney(entry.outstandingBefore);
          outstandingAfter = roundMoney(entry.outstandingAfter);
          balance = outstandingAfter;
          running = outstandingAfter;
        } else {
          outstandingBefore = running;
          running = roundMoney(running + net);
          outstandingAfter = running;
          balance = outstandingAfter;
        }
        return {
          _id: entry._id,
          createdAt: entry.createdAt,
          date: entry.entryDate,
          type: entry.debit > 0 ? "DEBIT" : "CREDIT",
          refType: entry.refType,
          debit: entry.debit || 0,
          credit: entry.credit || 0,
          balance,
          outstandingBefore,
          outstandingAfter,
          description: entry.description,
          orderId: entry.orderId,
          metadata: entry.metadata,
        };
      });

      const firstRow = entries[0];
      const lastRow = entries[entries.length - 1];
      debugLog("H3", "farmerPlantOrderLedger.controller.js:getFarmerPlantLedger", "Ledger API row-balance snapshot", {
        entriesInRangeCount: entriesInRange.length,
        mappedEntriesCount: entries.length,
        allHaveStored,
        openingBalance: roundMoney(openingBalance),
        firstRow: firstRow
          ? {
              refType: firstRow.refType,
              debit: firstRow.debit,
              credit: firstRow.credit,
              outstandingBefore: firstRow.outstandingBefore,
              outstandingAfter: firstRow.outstandingAfter,
              date: firstRow.date,
            }
          : null,
        lastRow: lastRow
          ? {
              refType: lastRow.refType,
              debit: lastRow.debit,
              credit: lastRow.credit,
              outstandingBefore: lastRow.outstandingBefore,
              outstandingAfter: lastRow.outstandingAfter,
              date: lastRow.date,
            }
          : null,
      });
    }
  }

  return res.status(200).json(
    generateResponse(
      "Success",
      "Farmer plant ledger",
      {
        farmer: farmerDoc
          ? {
              _id: farmerDoc._id,
              name: farmerDoc.name,
              mobileNumber: farmerDoc.mobileNumber,
              village: farmerDoc.village,
            }
          : null,
        summary: {
          totalBilled,
          totalCollected,
          outstanding: outstandingTotal,
          orderCount: orderRows.length,
        },
        orders: orderRows,
        ...(wantLineEntries ? { entries } : {}),
      },
      undefined
    )
  );
});

/**
 * GET single order details for farmer plant order (live or archived) + ledger lines.
 */
export const getFarmerPlantOrderDetails = catchAsync(async (req, res, next) => {
  const { orderId } = req.params;
  if (!orderId || !mongoose.isValidObjectId(orderId)) {
    return next(new AppError("Valid orderId is required", 400));
  }

  const oid = new mongoose.Types.ObjectId(orderId);

  let order = await Order.findById(oid).populate(orderDetailsPopulate);
  let source = "ACTIVE";

  if (!order) {
    const arch = await FarmerPlantOrderArchive.findOne({
      originalOrderId: oid,
    }).lean();
    if (!arch) {
      return next(new AppError("Order not found", 404));
    }
    source = "ARCHIVE";
    order = buildArchivedOrderPayload(arch);
  }

  if (order.dealerOrder === true) {
    return next(
      new AppError(
        "This endpoint is for farmer plant orders only (dealer orders use dealer flows)",
        400
      )
    );
  }

  const hasFarmer = Boolean(order.farmer);
  if (!hasFarmer) {
    return next(
      new AppError("Order has no farmer — not a farmer plant ledger order", 400)
    );
  }

  if (source === "ACTIVE" && !shouldLogFarmerPlantLedger(order)) {
    return next(
      new AppError("Order has no farmer — not a farmer plant ledger order", 400)
    );
  }

  const ledgerEntriesRaw = await FarmerPlantOrderLedgerEntry.find({
    orderId: oid,
  })
    .sort({ entryDate: 1 })
    .lean();
  const ledgerEntries = sortLedgerEntriesCanonical(ledgerEntriesRaw);

  const computed = computeOrderPaymentTotals(order);

  const payload = {
    source,
    order:
      source === "ACTIVE"
        ? order.toObject
          ? order.toObject()
          : order
        : order,
    payments: order.payment || [],
    ledgerEntries,
    computed,
  };

  return res
    .status(200)
    .json(generateResponse("Success", "Order details", payload, undefined));
});
