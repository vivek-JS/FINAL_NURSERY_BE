import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import Order from "../models/order.model.js";
import Farmer from "../models/farmer.model.js";
import FarmerPlantOrderLedgerEntry from "../models/farmerPlantOrderLedger.model.js";
import FarmerPlantOrderArchive from "../models/farmerPlantOrderArchive.model.js";
import Log from "../models/log.model.js";
import {
  shouldLogFarmerPlantLedger,
  normalizeFarmerMobile,
  computeOrderPaymentTotals,
  sortLedgerEntriesCanonical,
  roundMoney,
  getLastOutstandingAfterForCustomer,
  createFarmerPlantLedgerEntry,
  ensureFarmerPlantOrderDebit,
  recordFarmerPlantLedgerPaymentTransition,
  resolveFarmerIdentity,
  getFarmerPlantPaymentTransitionAction,
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
 * GET paginated parties (mobiles) that have farmer plant ledger entries.
 * Query: search, page, limit
 */
export const getFarmerPlantLedgerParties = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const skip = (page - 1) * limit;
  const search = String(req.query.search || "").trim();

  const preMatch = {};
  if (search.length >= 1) {
    const esc = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    preMatch.$or = [
      { customerName: { $regex: esc, $options: "i" } },
      { customerMobile: { $regex: esc, $options: "i" } },
    ];
  }

  const pipeline = [
    ...(Object.keys(preMatch).length ? [{ $match: preMatch }] : []),
    { $sort: { entryDate: 1, createdAt: 1 } },
    {
      $group: {
        _id: "$customerMobile",
        farmerId: { $last: "$farmer" },
        customerName: { $last: "$customerName" },
        lastOutstandingAfter: { $last: "$outstandingAfter" },
        lastEntryDate: { $last: "$entryDate" },
        lineCount: { $sum: 1 },
      },
    },
    { $sort: { lastEntryDate: -1 } },
    {
      $facet: {
        data: [{ $skip: skip }, { $limit: limit }],
        total: [{ $count: "count" }],
      },
    },
  ];

  const agg = await FarmerPlantOrderLedgerEntry.aggregate(pipeline);
  const facet = agg[0] || { data: [], total: [] };
  const rows = facet.data || [];
  const total = facet.total?.[0]?.count ?? 0;

  const farmerIds = rows.map((r) => r.farmerId).filter(Boolean);
  const farmers = await Farmer.find({ _id: { $in: farmerIds } })
    .select("name mobileNumber village taluka district")
    .lean();
  const byId = Object.fromEntries(
    farmers.map((f) => [f._id.toString(), f])
  );

  const items = rows.map((r) => {
    const fid = r.farmerId?.toString();
    const f = fid ? byId[fid] : null;
    return {
      customerMobile: r._id,
      customerName: r.customerName || f?.name || "",
      farmerId: r.farmerId || null,
      outstanding: roundMoney(Number(r.lastOutstandingAfter) || 0),
      lineCount: r.lineCount,
      lastEntryDate: r.lastEntryDate,
      village: f?.village || "",
      taluka: f?.taluka || "",
      district: f?.district || "",
    };
  });

  return res.status(200).json(
    generateResponse(
      "Success",
      "Ledger parties",
      {
        items,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit) || 1,
        },
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

function findPaymentSubdocument(order, paymentId) {
  if (!order?.payment?.length) return null;
  if (paymentId == null || paymentId === "") return null;
  let p = order.payment.id(paymentId);
  if (p) return p;
  const s = String(paymentId).trim();
  if (mongoose.Types.ObjectId.isValid(s)) {
    const oid = new mongoose.Types.ObjectId(s);
    p = order.payment.id(oid);
    if (p) return p;
  }
  return order.payment.find((x) => x?._id && String(x._id) === s);
}

/**
 * POST move one COLLECTED payment from a farmer plant order to another (same farmer).
 * Body: { sourceOrderId, targetOrderId, paymentId, message? }
 *
 * - Source payment → REJECTED + farmer-plant REVERSAL ledger line
 * - Target order → new payment PENDING then COLLECTED + PAYMENT ledger credit
 * - Excludes wallet payments and bulk-linked payments (mainPaymentId)
 */
export const transferFarmerPlantOrderPayment = catchAsync(async (req, res, next) => {
  const { sourceOrderId, targetOrderId, paymentId, message } = req.body || {};
  const msg = message != null && String(message).trim() ? String(message).trim() : "";

  const sid = sourceOrderId != null ? String(sourceOrderId).trim() : "";
  const tid = targetOrderId != null ? String(targetOrderId).trim() : "";
  const pid = paymentId != null ? String(paymentId).trim() : "";

  if (!mongoose.isValidObjectId(sid) || !mongoose.isValidObjectId(tid) || !mongoose.isValidObjectId(pid)) {
    return next(new AppError("Valid sourceOrderId, targetOrderId, and paymentId are required", 400));
  }
  if (sid === tid) {
    return next(new AppError("Source and target orders must be different", 400));
  }

  const performedBy = req.user?._id || req.user?.id;
  const transferId = new mongoose.Types.ObjectId();
  const session = await mongoose.startSession();
  session.startTransaction();

  let reversalEntryId = null;
  let paymentEntryId = null;

  try {
    const sourceOrder = await Order.findById(sid).populate(orderDetailsPopulate).session(session);
    const targetOrder = await Order.findById(tid).populate(orderDetailsPopulate).session(session);

    if (!sourceOrder || !targetOrder) {
      throw new AppError("Source or target order not found", 404);
    }
    if (sourceOrder.dealerOrder || targetOrder.dealerOrder) {
      throw new AppError("Payment transfer applies to farmer plant orders only", 400);
    }
    if (!shouldLogFarmerPlantLedger(sourceOrder) || !shouldLogFarmerPlantLedger(targetOrder)) {
      throw new AppError("Both orders must have a farmer for plant ledger", 400);
    }

    const fromParty = await resolveFarmerIdentity(sourceOrder);
    const toParty = await resolveFarmerIdentity(targetOrder);
    if (!fromParty.customerMobile || !toParty.customerMobile) {
      throw new AppError("Could not resolve farmer identity for one or both orders", 400);
    }
    if (fromParty.customerMobile !== toParty.customerMobile) {
      throw new AppError("Both orders must belong to the same farmer (mobile)", 400);
    }

    const sourcePayment = findPaymentSubdocument(sourceOrder, pid);
    if (!sourcePayment) {
      throw new AppError("Payment not found on source order", 404);
    }
    if (sourcePayment.paymentStatus !== "COLLECTED") {
      throw new AppError("Only COLLECTED payments can be transferred", 400);
    }
    if (sourcePayment.isWalletPayment) {
      throw new AppError("Wallet payments cannot be transferred in this flow", 400);
    }
    if (sourcePayment.mainPaymentId) {
      throw new AppError("Bulk-linked payments cannot be transferred", 400);
    }

    const amount = roundMoney(Math.abs(Number(sourcePayment.paidAmount || 0)));
    if (!(amount > 0)) {
      throw new AppError("Payment amount must be greater than zero", 400);
    }

    const targetNumericId = targetOrder.orderId ?? "";
    const sourceNumericId = sourceOrder.orderId ?? "";
    const transferNote = `[Transferred to order #${targetNumericId}${msg ? ` — ${msg}` : ""}]`;
    const prevRemark = sourcePayment.remark ? String(sourcePayment.remark).trim() : "";
    sourcePayment.remark = prevRemark ? `${prevRemark}\n${transferNote}` : transferNote;
    const prevSourceStatus = sourcePayment.paymentStatus;
    sourcePayment.paymentStatus = "REJECTED";

    await sourceOrder.save({ session });

    await ensureFarmerPlantOrderDebit(sourceOrder, { userId: performedBy, session });
    const sourceReversal = await recordFarmerPlantLedgerPaymentTransition(
      sourceOrder,
      sourcePayment,
      prevSourceStatus,
      "REJECTED",
      { userId: performedBy, session }
    );
    const revAction = getFarmerPlantPaymentTransitionAction(prevSourceStatus, "REJECTED");
    if (revAction === "REVERSAL" && !sourceReversal) {
      throw new AppError("Farmer ledger reversal was not recorded (duplicate or conflict)", 409);
    }
    reversalEntryId = sourceReversal?._id || null;

    const mode = sourcePayment.modeOfPayment || "Cash";
    const incomingNote = `[Transferred from order #${sourceNumericId}${msg ? ` — ${msg}` : ""}]`;
    const newPaymentPayload = {
      paidAmount: amount,
      paymentStatus: "PENDING",
      paymentDate: sourcePayment.paymentDate || new Date(),
      bankName: sourcePayment.bankName || "",
      receiptPhoto: Array.isArray(sourcePayment.receiptPhoto) ? [...sourcePayment.receiptPhoto] : [],
      modeOfPayment: mode,
      remark: incomingNote,
      chequeNumber: sourcePayment.chequeNumber || undefined,
      transactionId: sourcePayment.transactionId || undefined,
      utrNumber: sourcePayment.utrNumber || undefined,
      customerName: sourcePayment.customerName || undefined,
      isWalletPayment: false,
    };

    targetOrder.payment.push(newPaymentPayload);
    await targetOrder.save({ session });

    const newPayment = targetOrder.payment[targetOrder.payment.length - 1];
    if (!newPayment?._id) {
      throw new AppError("Failed to create payment on target order", 500);
    }

    const prevTargetPayStatus = newPayment.paymentStatus;
    newPayment.paymentStatus = "COLLECTED";
    await targetOrder.save({ session });

    await ensureFarmerPlantOrderDebit(targetOrder, { userId: performedBy, session });
    const targetCredit = await recordFarmerPlantLedgerPaymentTransition(
      targetOrder,
      newPayment,
      prevTargetPayStatus,
      "COLLECTED",
      { userId: performedBy, session }
    );
    const creditAction = getFarmerPlantPaymentTransitionAction(prevTargetPayStatus, "COLLECTED");
    if (creditAction === "CREDIT" && !targetCredit) {
      throw new AppError("Farmer ledger credit was not recorded (duplicate or conflict)", 409);
    }
    paymentEntryId = targetCredit?._id || null;

    const outstandingAfter = await getLastOutstandingAfterForCustomer(fromParty.customerMobile, session);

    await Log.create(
      [
        {
          userId: performedBy,
          modelName: "FarmerPlantOrderPaymentTransfer",
          documentId: transferId,
          operation: "CREATE",
          newState: {
            transferId,
            amount,
            message: msg || null,
            sourceOrderMongoId: sid,
            targetOrderMongoId: tid,
            sourceOrderNumericId: sourceNumericId,
            targetOrderNumericId: targetNumericId,
            originalPaymentId: pid,
            newPaymentId: newPayment._id ? String(newPayment._id) : null,
            reversalLedgerEntryId: reversalEntryId ? String(reversalEntryId) : null,
            paymentLedgerEntryId: paymentEntryId ? String(paymentEntryId) : null,
            customerMobile: fromParty.customerMobile,
            outstandingAfter: roundMoney(outstandingAfter),
          },
          changedFields: ["orderPaymentTransfer"],
          metadata: {
            transferId,
            sourceOrderId: sid,
            targetOrderId: tid,
            paymentId: pid,
          },
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json(
      generateResponse(
        "Success",
        "Payment transferred between orders",
        {
          transferId,
          amount,
          sourceOrder: { _id: sourceOrder._id, orderId: sourceOrder.orderId },
          targetOrder: { _id: targetOrder._id, orderId: targetOrder.orderId },
          reversalLedgerEntryId: reversalEntryId,
          paymentLedgerEntryId: paymentEntryId,
          outstandingAfter: roundMoney(outstandingAfter),
        },
        undefined
      )
    );
  } catch (e) {
    try {
      await session.abortTransaction();
    } catch (_) {}
    try {
      session.endSession();
    } catch (_) {}
    return next(e instanceof AppError ? e : new AppError(e.message || "Transfer failed", 500));
  }
});

/**
 * POST transfer farmer plant advance between two farmers.
 * Body: { fromFarmerId|fromMobile, toFarmerId|toMobile, amount, reason, orderId? }
 *
 * Rules:
 * - Only allowed if source has advance (outstanding < 0)
 * - amount must be <= |advance|
 * - if orderId is provided, destination farmer/mobile must match that order's farmer
 * - Writes two immutable ADJUSTMENT rows linked by transferId + creates an audit Log entry.
 */
export const transferFarmerPlantAdvance = catchAsync(async (req, res, next) => {
  const {
    fromFarmerId,
    fromMobile,
    toFarmerId,
    toMobile,
    amount,
    reason,
    orderId,
  } = req.body || {};

  const amt = roundMoney(Math.abs(Number(amount || 0)));
  if (!(amt > 0)) {
    return next(new AppError("amount must be > 0", 400));
  }

  const resolveParty = async ({ farmerId, mobile }, session) => {
    if (farmerId && mongoose.isValidObjectId(farmerId)) {
      const f = await Farmer.findById(farmerId).session(session);
      if (!f) return null;
      const m = normalizeFarmerMobile(f.mobileNumber);
      return {
        farmerId: f._id,
        name: (f.name || "").trim(),
        mobile: m,
      };
    }

    const mNorm = mobile ? normalizeFarmerMobile(mobile) : null;
    if (mNorm) {
      const asNum = Number(mNorm);
      const f = await Farmer.findOne({ mobileNumber: asNum }).session(session);
      return {
        farmerId: f?._id || null,
        name: (f?.name || "").trim(),
        mobile: mNorm,
      };
    }
    return null;
  };

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const from = await resolveParty(
      { farmerId: fromFarmerId, mobile: fromMobile },
      session
    );
    let to = await resolveParty(
      { farmerId: toFarmerId, mobile: toMobile },
      session
    );

    if (!from?.mobile) {
      throw new AppError("Valid from farmerId or fromMobile is required", 400);
    }
    const orderIdRaw = orderId != null ? String(orderId).trim() : "";
    let linkedOrder = null;
    let linkedOrderMobile = null;
    let linkedOrderFarmer = null;
    if (orderIdRaw) {
      if (!mongoose.isValidObjectId(orderIdRaw)) {
        throw new AppError("Invalid orderId", 400);
      }
      linkedOrder = await Order.findById(orderIdRaw)
        .select("_id orderId farmer dealerOrder")
        .session(session)
        .lean();
      if (!linkedOrder) {
        throw new AppError("Order not found for provided orderId", 404);
      }
      if (linkedOrder.dealerOrder) {
        throw new AppError("Only farmer plant orders can be linked to transfer", 400);
      }
      if (!linkedOrder.farmer) {
        throw new AppError("Selected order has no farmer mapping", 400);
      }
      linkedOrderFarmer = await Farmer.findById(linkedOrder.farmer)
        .select("name mobileNumber village taluka district")
        .session(session)
        .lean();
      linkedOrderMobile = linkedOrderFarmer
        ? normalizeFarmerMobile(linkedOrderFarmer.mobileNumber)
        : null;
      if (!linkedOrderMobile) {
        throw new AppError("Selected order farmer has no valid mobile", 400);
      }
      if (!to?.mobile) {
        to = {
          farmerId: linkedOrderFarmer?._id || linkedOrder.farmer,
          name: (linkedOrderFarmer?.name || "").trim(),
          mobile: linkedOrderMobile,
        };
      } else {
        if (linkedOrderMobile !== to.mobile) {
          throw new AppError("Selected order does not belong to selected target farmer", 400);
        }
        if (to.farmerId && String(to.farmerId) !== String(linkedOrder.farmer)) {
          throw new AppError("Selected order does not belong to selected target farmer", 400);
        }
      }
    }
    if (!to?.mobile) {
      throw new AppError("Valid to farmerId or toMobile is required", 400);
    }
    if (from.mobile === to.mobile) {
      throw new AppError("from and to must be different farmers", 400);
    }

    const beforeFrom = await getLastOutstandingAfterForCustomer(from.mobile, session);
    const availableAdvance = beforeFrom < 0 ? roundMoney(Math.abs(beforeFrom)) : 0;
    if (!(availableAdvance > 0)) {
      throw new AppError("Source farmer has no advance available to transfer", 400);
    }
    if (amt > availableAdvance) {
      throw new AppError(
        `Transfer amount exceeds available advance (max ₹${availableAdvance})`,
        400
      );
    }

    const transferId = new mongoose.Types.ObjectId();
    const entryDate = new Date();
    const performedBy = req.user?._id || undefined;
    const reasonText = reason != null && String(reason).trim()
      ? String(reason).trim()
      : undefined;

    const commonMeta = {
      transferId,
      from: { farmerId: from.farmerId, mobile: from.mobile, name: from.name || "" },
      to: { farmerId: to.farmerId, mobile: to.mobile, name: to.name || "" },
      reason: reasonText || null,
      order: linkedOrder
        ? {
            orderObjectId: linkedOrder._id,
            orderNumericId: linkedOrder.orderId ?? null,
            farmerId: linkedOrder.farmer || null,
            mobile: linkedOrderMobile,
          }
        : null,
    };

    const fromEntry = await createFarmerPlantLedgerEntry({
      customerMobile: from.mobile,
      customerName: from.name,
      farmerId: from.farmerId,
      refType: "ADJUSTMENT",
      refId: transferId,
      debit: amt,
      category: "Advance Transfer",
      description: `Advance transferred to ${to.name || "farmer"} (${to.mobile})${reasonText ? ` — ${reasonText}` : ""}`,
      entryDate,
      createdBy: performedBy,
      metadata: { ...commonMeta, direction: "OUT" },
      session,
    });

    const toEntry = await createFarmerPlantLedgerEntry({
      customerMobile: to.mobile,
      customerName: to.name,
      farmerId: to.farmerId,
      refType: "ADJUSTMENT",
      refId: transferId,
      orderId: linkedOrder?._id || undefined,
      credit: amt,
      reference: linkedOrder ? String(linkedOrder.orderId ?? "") : undefined,
      category: "Advance Transfer",
      description: `Advance received from ${from.name || "farmer"} (${from.mobile})${linkedOrder ? ` · order #${linkedOrder.orderId ?? ""}` : ""}${reasonText ? ` — ${reasonText}` : ""}`,
      entryDate,
      createdBy: performedBy,
      metadata: { ...commonMeta, direction: "IN" },
      session,
    });

    const afterFrom = await getLastOutstandingAfterForCustomer(from.mobile, session);
    const afterTo = await getLastOutstandingAfterForCustomer(to.mobile, session);

    await Log.create(
      [
        {
          userId: performedBy,
          modelName: "FarmerPlantLedgerAdvanceTransfer",
          documentId: transferId,
          operation: "CREATE",
          newState: {
            transferId,
            amount: amt,
            from,
            to,
            fromEntryId: fromEntry?._id || null,
            toEntryId: toEntry?._id || null,
            beforeFrom,
            afterFrom,
            beforeTo: null,
            afterTo,
            reason: reasonText || null,
            order: linkedOrder
              ? {
                  orderObjectId: linkedOrder._id,
                  orderNumericId: linkedOrder.orderId ?? null,
                }
              : null,
          },
          changedFields: ["advanceTransfer"],
          metadata: commonMeta,
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json(
      generateResponse(
        "Success",
        "Advance transferred",
        {
          transferId,
          amount: amt,
          order: linkedOrder
            ? {
                orderObjectId: linkedOrder._id,
                orderNumericId: linkedOrder.orderId ?? null,
              }
            : null,
          from: { mobile: from.mobile, farmerId: from.farmerId, name: from.name, outstandingAfter: afterFrom },
          to: { mobile: to.mobile, farmerId: to.farmerId, name: to.name, outstandingAfter: afterTo },
        },
        undefined
      )
    );
  } catch (e) {
    try {
      await session.abortTransaction();
    } catch (_) {}
    session.endSession();
    return next(e);
  }
});

/**
 * GET farmer lookup for ledger transfer target picker.
 * Query: q (name/mobile), limit (default 20, max 50)
 */
export const searchFarmersForLedgerTransfer = catchAsync(async (req, res) => {
  const q = String(req.query?.q || "").trim();
  const limitNum = Number(req.query?.limit || 20);
  const limit = Number.isFinite(limitNum)
    ? Math.min(Math.max(Math.trunc(limitNum), 1), 50)
    : 20;

  const filter = {};
  if (q) {
    const mobileDigits = q.replace(/\D/g, "");
    const or = [{ name: { $regex: q, $options: "i" } }];
    if (mobileDigits) {
      // mobileNumber is stored as Number in this codebase, so use regex over string cast.
      or.push({
        $expr: {
          $regexMatch: {
            input: { $toString: "$mobileNumber" },
            regex: mobileDigits,
          },
        },
      });
    }
    filter.$or = or;
  }

  const farmers = await Farmer.find(filter)
    .select("name mobileNumber village taluka district")
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(limit)
    .lean();

  return res.status(200).json(
    generateResponse(
      "Success",
      "Farmers fetched",
      {
        items: (farmers || []).map((f) => ({
          _id: f._id,
          name: f.name || "",
          mobileNumber: f.mobileNumber || null,
          village: f.village || "",
          taluka: f.taluka || "",
          district: f.district || "",
        })),
      },
      undefined
    )
  );
});

/**
 * POST manual ledger adjustment entry (debit/credit).
 * Body:
 * {
 *   farmerId|mobileNumber,
 *   entryType: "DEBIT" | "CREDIT",
 *   amount,
 *   modeOfPayment,
 *   remark,
 *   bankName?,
 *   transactionId?,
 *   chequeNumber?,
 *   entryDate?
 * }
 */
export const createManualFarmerPlantLedgerEntry = catchAsync(
  async (req, res, next) => {
    const {
      farmerId,
      mobileNumber,
      entryType,
      amount,
      modeOfPayment,
      remark,
      bankName,
      transactionId,
      chequeNumber,
      entryDate,
    } = req.body || {};

    const type = String(entryType || "").trim().toUpperCase();
    if (!["DEBIT", "CREDIT"].includes(type)) {
      return next(new AppError("entryType must be DEBIT or CREDIT", 400));
    }

    const amt = roundMoney(Math.abs(Number(amount || 0)));
    if (!(amt > 0)) {
      return next(new AppError("amount must be > 0", 400));
    }

    const mode = String(modeOfPayment || "").trim();
    const allowedModes = [
      "Cash",
      "UPI",
      "Cheque",
      "NEFT/RTGS",
      "Bank Transfer",
      "Card",
    ];
    if (!mode || !allowedModes.includes(mode)) {
      return next(
        new AppError(`modeOfPayment is required (${allowedModes.join(", ")})`, 400)
      );
    }

    const remarkText = String(remark || "").trim();
    if (!remarkText) {
      return next(new AppError("remark is required", 400));
    }

    const needsBankName = ["UPI", "Cheque", "NEFT/RTGS", "Bank Transfer", "Card"].includes(mode);
    if (needsBankName && !String(bankName || "").trim()) {
      return next(new AppError("bankName is required for this mode", 400));
    }

    let farmerDoc = null;
    if (farmerId && mongoose.isValidObjectId(farmerId)) {
      farmerDoc = await Farmer.findById(farmerId).lean();
    }
    if (!farmerDoc && mobileNumber) {
      const mobileNorm = normalizeFarmerMobile(mobileNumber);
      if (mobileNorm) {
        farmerDoc = await Farmer.findOne({ mobileNumber: Number(mobileNorm) }).lean();
      }
    }
    if (!farmerDoc) {
      return next(new AppError("Valid farmerId or mobileNumber is required", 400));
    }

    const customerMobile = normalizeFarmerMobile(farmerDoc.mobileNumber);
    if (!customerMobile) {
      return next(new AppError("Farmer has invalid mobile number", 400));
    }

    const manualId = new mongoose.Types.ObjectId();
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const createdBy = req.user?._id || undefined;
      const created = await createFarmerPlantLedgerEntry({
        customerMobile,
        customerName: (farmerDoc.name || "").trim(),
        farmerId: farmerDoc._id,
        refType: "ADJUSTMENT",
        refId: manualId,
        debit: type === "DEBIT" ? amt : 0,
        credit: type === "CREDIT" ? amt : 0,
        category: "Manual Entry",
        description: `Manual ${type.toLowerCase()} entry — ${remarkText}`,
        entryDate: entryDate ? new Date(entryDate) : new Date(),
        createdBy,
        metadata: {
          manualEntryId: manualId,
          entryType: type,
          modeOfPayment: mode,
          bankName: bankName ? String(bankName).trim() : undefined,
          transactionId: transactionId ? String(transactionId).trim() : undefined,
          chequeNumber: chequeNumber ? String(chequeNumber).trim() : undefined,
          remark: remarkText,
        },
        session,
      });

      const outstandingAfter = await getLastOutstandingAfterForCustomer(customerMobile, session);

      await Log.create(
        [
          {
            userId: createdBy,
            modelName: "FarmerPlantLedgerManualEntry",
            documentId: manualId,
            operation: "CREATE",
            newState: {
              manualEntryId: manualId,
              ledgerEntryId: created?._id || null,
              farmer: {
                _id: farmerDoc._id,
                name: farmerDoc.name || "",
                mobileNumber: farmerDoc.mobileNumber || null,
              },
              entryType: type,
              amount: amt,
              modeOfPayment: mode,
              bankName: bankName ? String(bankName).trim() : null,
              transactionId: transactionId ? String(transactionId).trim() : null,
              chequeNumber: chequeNumber ? String(chequeNumber).trim() : null,
              remark: remarkText,
              outstandingAfter,
            },
            changedFields: ["manualLedgerEntry"],
            metadata: {
              manualEntryId: manualId,
              farmerId: farmerDoc._id,
              customerMobile,
              entryType: type,
              amount: amt,
            },
          },
        ],
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      return res.status(200).json(
        generateResponse(
          "Success",
          "Manual ledger entry created",
          {
            manualEntryId: manualId,
            ledgerEntryId: created?._id || null,
            outstandingAfter: roundMoney(outstandingAfter),
          },
          undefined
        )
      );
    } catch (e) {
      try {
        await session.abortTransaction();
      } catch (_) {}
      session.endSession();
      return next(e);
    }
  }
);
