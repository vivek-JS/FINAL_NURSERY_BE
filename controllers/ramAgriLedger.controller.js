import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import AppError from "../utility/appError.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import GRN from "../models/grn.model.js";
import mongoose from "mongoose";
import RamAgriCustomerLedgerEntry from "../models/ramAgriCustomerLedger.model.js";
import Log from "../models/log.model.js";
import { roundMoney } from "../utils/farmerPlantOrderLedgerHelper.js";
import {
  createCustomerLedgerEntry,
  getRamAgriRunningBalanceAfterMobile,
  normalizeAgriCustomerMobile,
} from "../utils/ramAgriLedgerHelper.js";

// ==================== VARIETY/PRODUCT LEDGER ====================

export const getVarietyLedger = catchAsync(async (req, res, next) => {
  const { cropId, varietyId, startDate, endDate } = req.query;

  // If no cropId and varietyId provided, return empty result
  if (!cropId || !varietyId) {
    return res.status(200).json(
      generateResponse(
        "Success",
        "No filter provided. Please provide cropId and varietyId as query parameters",
        {
          variety: null,
          summary: {
            openingStock: 0,
            totalCredit: 0,
            totalDebit: 0,
            closingStock: 0,
          },
          entries: [],
        },
        undefined
      )
    );
  }

  // Get variety details
  const crop = await RamAgriInputsProduct.findById(cropId).lean();
  if (!crop) {
    return res.status(404).json({
      status: "Error",
      message: "Crop not found",
    });
  }

  const variety = crop.varieties.find(v => v._id.toString() === varietyId);
  if (!variety) {
    return res.status(404).json({
      status: "Error",
      message: "Variety not found",
    });
  }

  // Date filter
  const dateFilter = {};
  const startDateObj = startDate ? new Date(startDate) : null;
  const endDateObj = endDate ? new Date(endDate + 'T23:59:59.999Z') : null;
  if (startDateObj && endDateObj) {
    dateFilter.$gte = startDateObj;
    dateFilter.$lte = endDateObj;
  } else if (startDateObj) {
    dateFilter.$gte = startDateObj;
  } else if (endDateObj) {
    dateFilter.$lte = endDateObj;
  }

  const isWithinDateRange = (date) => {
    if (!date || Object.keys(dateFilter).length === 0) return true;
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) return false;
    if (dateFilter.$gte && parsed < dateFilter.$gte) return false;
    if (dateFilter.$lte && parsed > dateFilter.$lte) return false;
    return true;
  };

  const isWithinDateFilter = (date) => {
    if (!date || Object.keys(dateFilter).length === 0) return true;
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) return false;
    if (dateFilter.$gte && parsed < dateFilter.$gte) return false;
    if (dateFilter.$lte && parsed > dateFilter.$lte) return false;
    return true;
  };

  // Get all GRNs for this variety (CREDIT - Stock additions)
  const grns = await GRN.find({
    'items.isRamAgriProduct': true,
    'items.ramAgriCropId': new mongoose.Types.ObjectId(cropId),
    'items.ramAgriVarietyId': new mongoose.Types.ObjectId(varietyId),
    ...(Object.keys(dateFilter).length > 0 ? { grnDate: dateFilter } : {}),
  })
    .populate('supplier', 'name code')
    .populate('purchaseOrder', 'orderNumber')
    .sort({ grnDate: -1 })
    .lean();

  // Get all dispatched sales orders (DEBIT) - ONLY track manager dispatches (stockDeducted = true)
  // Sales person dispatches don't impact warehouse stock, so they shouldn't appear in variety ledger
  const dispatchDateFilter = {};
  if (Object.keys(dateFilter).length > 0) {
    dispatchDateFilter.dispatchedAt = dateFilter;
  }
  
  const salesOrders = await AgriSalesOrder.find({
    isRamAgriProduct: true,
    ramAgriCropId: new mongoose.Types.ObjectId(cropId),
    ramAgriVarietyId: new mongoose.Types.ObjectId(varietyId),
    dispatchStatus: { $in: ["DISPATCHED", "IN_TRANSIT", "DELIVERED"] },
    stockDeducted: true, // ONLY manager dispatches (stock deducted = true)
    ...dispatchDateFilter,
  })
    .sort({ dispatchedAt: -1 })
    .lean();

  // Build ledger entries
  const ledgerEntries = [];

  // Add GRNs (CREDIT - actual stock addition)
  grns.forEach(grn => {
    const item = grn.items.find(i => 
      i.isRamAgriProduct && 
      i.ramAgriCropId?.toString() === cropId &&
      i.ramAgriVarietyId?.toString() === varietyId
    );
    if (item) {
      ledgerEntries.push({
        date: grn.grnDate || grn.createdAt,
        type: 'CREDIT',
        category: 'GRN',
        reference: grn.grnNumber || grn._id.toString(),
        description: `Goods Receipt - ${grn.supplier?.name || 'Supplier'}`,
        quantity: item.acceptedQuantity || item.quantity || 0,
        unit: item.unit || null,
        rate: item.rate || 0,
        amount: item.amount || 0,
        balance: 0,
        details: {
          grnId: grn._id,
          poNumber: grn.purchaseOrder?.orderNumber,
          supplier: grn.supplier,
          status: grn.status,
        },
      });
    }
  });

  // Add Sales Orders (DEBIT) - Only manager dispatches (stockDeducted = true)
  // All orders in salesOrders array already have stockDeducted = true
  salesOrders.forEach(order => {
    const dispatchDate = order.dispatchedAt || order.stockDeductedAt || order.orderDate || order.createdAt;
    const dispatchMode = order.dispatchMode || "UNKNOWN";
    
    ledgerEntries.push({
      date: dispatchDate,
      type: 'DEBIT',
      category: 'Sale (Manager Dispatch)',
      reference: order.orderNumber || order._id.toString(),
      description: `Sale to ${order.customerName || 'Customer'}`,
      quantity: order.quantity || 0,
      unit: order.primaryUnit || null,
      rate: order.rate || 0,
      amount: order.totalAmount || 0,
      balance: 0,
      details: {
        orderId: order._id,
        customerName: order.customerName,
        customerMobile: order.customerMobile,
        paymentStatus: order.paymentStatus,
        orderStatus: order.orderStatus,
        dispatchStatus: order.dispatchStatus,
        dispatchedAt: order.dispatchedAt,
        stockDeducted: true, // Always true for variety ledger entries
        stockDeductedAt: order.stockDeductedAt,
        dispatchMode: dispatchMode,
        vehicleNumber: order.vehicleNumber,
        driverName: order.driverName,
        driverMobile: order.driverMobile,
      },
    });
  });

  // Add Stock Returns (CREDIT) from completed orders
  // ONLY track returns from manager-dispatched orders (stockReturned = true)
  // Sales person order returns don't impact warehouse stock, so they shouldn't appear in variety ledger
  const returnDateFilter = {};
  if (Object.keys(dateFilter).length > 0) {
    returnDateFilter.stockReturnedAt = dateFilter;
    // Also check completedAt if stockReturnedAt is not available
    if (!returnDateFilter.stockReturnedAt) {
      returnDateFilter.completedAt = dateFilter;
    }
  }
  
  const ordersWithReturns = await AgriSalesOrder.find({
    isRamAgriProduct: true,
    ramAgriCropId: new mongoose.Types.ObjectId(cropId),
    ramAgriVarietyId: new mongoose.Types.ObjectId(varietyId),
    returnQuantity: { $gt: 0 }, // Has returns
    orderStatus: "COMPLETED", // Only completed orders can have returns
    stockReturned: true, // ONLY manager-dispatched orders (stock was returned to warehouse)
  })
    .sort({ stockReturnedAt: -1, completedAt: -1 })
    .lean();
  
  ordersWithReturns.forEach(order => {
    const returnDate = order.stockReturnedAt || order.completedAt || order.updatedAt || order.createdAt;
    if (
      order.returnQuantity &&
      order.returnQuantity > 0 &&
      isWithinDateFilter(returnDate)
    ) {
      ledgerEntries.push({
        date: returnDate,
        type: 'CREDIT',
        category: 'Sales Return (Stock Added)',
        reference: order.orderNumber || order._id.toString(),
        description: `Return from ${order.customerName || 'Customer'}${order.returnReason ? ` - ${order.returnReason}` : ''}`,
        quantity: order.returnQuantity || 0,
        unit: order.primaryUnit || null,
        rate: order.rate || 0,
        amount: (order.returnQuantity || 0) * (order.rate || 0),
        balance: 0,
        details: {
          orderId: order._id,
          returnQuantity: order.returnQuantity,
          deliveredQuantity: order.deliveredQuantity,
          originalQuantity: order.quantity,
          returnReason: order.returnReason,
          returnNotes: order.returnNotes,
          stockReturned: true, // Always true for variety ledger entries
          stockReturnedAt: order.stockReturnedAt,
          completedAt: order.completedAt,
        },
      });
    }
  });

  // Sort by date
  ledgerEntries.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Calculate running balance from opening stock
  const totalCredit = ledgerEntries
    .filter(e => e.type === 'CREDIT')
    .reduce((sum, e) => sum + (e.quantity || 0), 0);
  const totalDebit = ledgerEntries
    .filter(e => e.type === 'DEBIT')
    .reduce((sum, e) => sum + (e.quantity || 0), 0);
  const openingStock = (variety.currentStock || 0) - totalCredit + totalDebit;

  let runningBalance = openingStock;
  const entriesWithBalance = ledgerEntries.map(entry => {
    if (entry.type === 'CREDIT') {
      runningBalance += entry.quantity;
    } else {
      runningBalance -= entry.quantity;
    }
    return {
      ...entry,
      balance: runningBalance,
    };
  }).reverse(); // Reverse to show latest first

  const response = generateResponse(
    "Success",
    "Variety ledger fetched successfully",
    {
      variety: {
        cropId: crop._id,
        cropName: crop.cropName,
        varietyId: variety._id,
        varietyName: variety.name,
        currentStock: variety.currentStock || 0,
        stockValue: variety.stockValue || 0,
        averagePrice: variety.averagePrice || 0,
      },
      summary: {
        openingStock,
        totalCredit,
        totalDebit,
        closingStock: variety.currentStock || 0,
      },
      entries: entriesWithBalance,
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== CUSTOMER LEDGER ====================

export const getCustomerLedger = catchAsync(async (req, res, next) => {
  const { customerMobile, customerName, customerId, startDate, endDate } = req.query;

  // If no customerMobile and customerName provided, return empty result
  if (!customerMobile && !customerName && !customerId) {
    return res.status(200).json(
      generateResponse(
        "Success",
        "No filter provided. Please provide customerMobile, customerName, or customerId as query parameter",
        {
          customer: null,
          summary: {
            totalOrders: 0,
            openingBalance: 0,
            totalDebit: 0,
            totalCredit: 0,
            outstanding: 0,
          },
          entries: [],
        },
        undefined
      )
    );
  }

  const customerFilter = {};
  if (customerMobile) customerFilter.customerMobile = customerMobile;
  if (customerName) customerFilter.customerName = new RegExp(customerName, 'i');

  let allEntries = await RamAgriCustomerLedgerEntry.find(customerFilter)
    .sort({ entryDate: 1 })
    .lean();

  const orders = await AgriSalesOrder.find({
    isRamAgriProduct: true,
    ...customerFilter,
  }).lean();

  if (orders.length === 0 && allEntries.length === 0) {
    return res.status(404).json({
      status: "Error",
      message: "No ledger entries found for this customer",
    });
  }

  const existingOrderRefs = new Set(
    allEntries.filter((entry) => entry.refType === "ORDER").map((entry) => entry.refId?.toString())
  );
  const existingPaymentRefs = new Set(
    allEntries.filter((entry) => entry.refType === "PAYMENT").map((entry) => entry.refId?.toString())
  );
  const existingOrderReversals = new Set(
    allEntries
      .filter((entry) => entry.refType === "REVERSAL" && entry.orderId)
      .map((entry) => entry.refId?.toString())
  );

  const newEntries = [];
  orders.forEach((order) => {
    const orderId = order._id?.toString();
    if (orderId && !existingOrderRefs.has(orderId)) {
      newEntries.push({
        customerMobile: order.customerMobile,
        customerName: order.customerName,
        entryDate: order.orderDate || order.createdAt,
        refType: "ORDER",
        refId: order._id,
        orderId: order._id,
        debit: order.totalAmount || 0,
        reference: order.orderNumber,
        category: "Order",
        description: `Order: ${order.ramAgriCropName || "Unknown"} - ${order.ramAgriVarietyName || "Unknown"}`,
        createdBy: order.createdBy,
        metadata: {
          customerVillage: order.customerVillage,
          customerTaluka: order.customerTaluka,
          customerDistrict: order.customerDistrict,
          orderStatus: order.orderStatus,
        },
      });
    }

    if (order.payment && Array.isArray(order.payment)) {
      order.payment
        .filter((payment) => payment.paymentStatus === "COLLECTED")
        .forEach((payment) => {
          const paymentId = payment._id?.toString();
          if (paymentId && !existingPaymentRefs.has(paymentId)) {
            newEntries.push({
              customerMobile: order.customerMobile,
              customerName: order.customerName,
              entryDate: payment.paymentDate || order.orderDate || order.createdAt,
              refType: "PAYMENT",
              refId: payment._id,
              orderId: order._id,
              paymentId: payment._id,
              credit: payment.paidAmount || 0,
              reference: order.orderNumber,
              category: "Payment",
              description: `Payment via ${payment.modeOfPayment || "N/A"}`,
              createdBy: order.createdBy,
              metadata: {
                paymentStatus: payment.paymentStatus,
                modeOfPayment: payment.modeOfPayment,
              },
            });
          }
        });
    }

    if (["CANCELLED", "REJECTED"].includes(order.orderStatus) && orderId) {
      if (!existingOrderReversals.has(orderId)) {
        newEntries.push({
          customerMobile: order.customerMobile,
          customerName: order.customerName,
          entryDate: order.updatedAt || order.createdAt,
          refType: "REVERSAL",
          refId: order._id,
          orderId: order._id,
          credit: order.totalAmount || 0,
          reference: order.orderNumber,
          category: "Order Reversal",
          description: `Order ${order.orderStatus.toLowerCase()}`,
          createdBy: order.createdBy,
          metadata: {
            orderStatus: order.orderStatus,
          },
        });
      }
    }
  });

  if (newEntries.length > 0) {
    await RamAgriCustomerLedgerEntry.insertMany(newEntries);
    allEntries = await RamAgriCustomerLedgerEntry.find(customerFilter)
      .sort({ entryDate: 1 })
      .lean();
  }

  const startDateObj = startDate ? new Date(startDate) : null;
  const endDateObj = endDate ? new Date(endDate + 'T23:59:59.999Z') : null;

  const openingBalance = allEntries
    .filter((entry) => startDateObj && new Date(entry.entryDate) < startDateObj)
    .reduce((sum, entry) => sum + (entry.debit || 0) - (entry.credit || 0), 0);

  const entriesInRange = allEntries.filter((entry) => {
    const entryDate = new Date(entry.entryDate);
    if (startDateObj && entryDate < startDateObj) return false;
    if (endDateObj && entryDate > endDateObj) return false;
    return true;
  }).sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));

  let runningBalance = openingBalance;
  const entriesWithBalance = entriesInRange.map((entry) => {
    runningBalance += (entry.debit || 0) - (entry.credit || 0);
    return {
      date: entry.entryDate,
      type: entry.debit > 0 ? "DEBIT" : "CREDIT",
      category: entry.category || entry.refType,
      reference: entry.reference || entry.refId?.toString(),
      description: entry.description || "",
      amount: entry.debit > 0 ? entry.debit : entry.credit,
      balance: runningBalance,
      details: {
        refType: entry.refType,
        refId: entry.refId,
        orderId: entry.orderId,
        paymentId: entry.paymentId,
        ...(entry.metadata || {}),
      },
    };
  }).reverse();

  const totalDebit = entriesInRange.reduce((sum, entry) => sum + (entry.debit || 0), 0);
  const totalCredit = entriesInRange.reduce((sum, entry) => sum + (entry.credit || 0), 0);
  const outstanding = openingBalance + totalDebit - totalCredit;
  const totalOrders = entriesInRange.filter((entry) => entry.refType === "ORDER").length;

  const lastEntry = allEntries[allEntries.length - 1];
  const customer = {
    name: lastEntry?.customerName || customerName || "Unknown",
    mobile: lastEntry?.customerMobile || customerMobile || "",
    village: lastEntry?.metadata?.customerVillage || "",
    taluka: lastEntry?.metadata?.customerTaluka || "",
    district: lastEntry?.metadata?.customerDistrict || "",
  };

  const response = generateResponse(
    "Success",
    "Customer ledger fetched successfully",
    {
      customer,
      summary: {
        totalOrders,
        openingBalance,
        totalDebit,
        totalCredit,
        outstanding,
      },
      entries: entriesWithBalance,
    },
    undefined
  );

  return res.status(200).json(response);
});

async function resolveRamAgriStoredMobile(digits10, session) {
  if (!digits10) return null;
  const q = (fn) => (session ? fn.session(session) : fn);
  let doc = await q(
    RamAgriCustomerLedgerEntry.findOne({ customerMobile: digits10 }).select("customerMobile")
  ).lean();
  if (doc?.customerMobile) return doc.customerMobile;
  doc = await q(
    RamAgriCustomerLedgerEntry.findOne({
      customerMobile: new RegExp(`${digits10}$`),
    }).select("customerMobile")
  ).lean();
  if (doc?.customerMobile) return doc.customerMobile;
  const ord = await q(
    AgriSalesOrder.findOne({
      isRamAgriProduct: true,
      customerMobile: new RegExp(`${digits10}$`),
    }).select("customerMobile")
  ).lean();
  return ord?.customerMobile || digits10;
}

/** GET — search Ram Agri customers (ledger + orders) for transfer picker */
export const searchRamAgriCustomersForLedgerTransfer = catchAsync(async (req, res) => {
  const q = String(req.query?.q || "").trim();
  const limitNum = Number(req.query?.limit || 20);
  const limit = Number.isFinite(limitNum)
    ? Math.min(Math.max(Math.trunc(limitNum), 1), 50)
    : 20;

  const matchOrder = { isRamAgriProduct: true };
  if (q.length >= 2) {
    const mobileDigits = q.replace(/\D/g, "");
    matchOrder.$or = [
      { customerName: { $regex: q, $options: "i" } },
      ...(mobileDigits ? [{ customerMobile: { $regex: mobileDigits, $options: "i" } }] : []),
    ];
  }

  const rows = await AgriSalesOrder.aggregate([
    { $match: matchOrder },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$customerMobile",
        customerName: { $first: "$customerName" },
        customerVillage: { $first: "$customerVillage" },
        customerTaluka: { $first: "$customerTaluka" },
        customerDistrict: { $first: "$customerDistrict" },
      },
    },
    { $limit: limit },
  ]);

  const items = (rows || []).map((r) => ({
    _id: r._id,
    name: r.customerName || "",
    mobileNumber: r._id,
    village: r.customerVillage || "",
    taluka: r.customerTaluka || "",
    district: r.customerDistrict || "",
  }));

  return res.status(200).json(
    generateResponse("Success", "Customers fetched", { items }, undefined)
  );
});

/** POST — transfer advance between Ram Agri customers (same rules as farmer plant ledger) */
export const transferRamAgriCustomerAdvance = catchAsync(async (req, res, next) => {
  const { fromMobile, toMobile, amount, reason } = req.body || {};
  const amt = roundMoney(Math.abs(Number(amount || 0)));
  if (!(amt > 0)) {
    return next(new AppError("amount must be > 0", 400));
  }

  const fromDigits = normalizeAgriCustomerMobile(fromMobile);
  const toDigits = normalizeAgriCustomerMobile(toMobile);
  if (!fromDigits || fromDigits.length < 10) {
    return next(new AppError("Valid fromMobile is required", 400));
  }
  if (!toDigits || toDigits.length < 10) {
    return next(new AppError("Valid toMobile is required", 400));
  }
  if (fromDigits === toDigits) {
    return next(new AppError("from and to must be different customers", 400));
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const fromStored = await resolveRamAgriStoredMobile(fromDigits, session);
    const toStored = await resolveRamAgriStoredMobile(toDigits, session);
    if (!fromStored || !toStored) {
      throw new AppError("Could not resolve customer mobile", 400);
    }
    if (fromStored === toStored) {
      throw new AppError("from and to must be different customers", 400);
    }

    const beforeFrom = await getRamAgriRunningBalanceAfterMobile(fromStored, session);
    const availableAdvance = beforeFrom < 0 ? roundMoney(Math.abs(beforeFrom)) : 0;
    if (!(availableAdvance > 0)) {
      throw new AppError("Source customer has no advance available to transfer", 400);
    }
    if (amt > availableAdvance) {
      throw new AppError(
        `Transfer amount exceeds available advance (max ₹${availableAdvance})`,
        400
      );
    }

    const lastFrom = await RamAgriCustomerLedgerEntry.findOne({ customerMobile: fromStored })
      .sort({ entryDate: -1, createdAt: -1 })
      .session(session)
      .select("customerName")
      .lean();
    const lastTo = await RamAgriCustomerLedgerEntry.findOne({ customerMobile: toStored })
      .sort({ entryDate: -1, createdAt: -1 })
      .session(session)
      .select("customerName")
      .lean();
    const fromName = (lastFrom?.customerName || "").trim();
    const toName = (lastTo?.customerName || "").trim();

    const transferId = new mongoose.Types.ObjectId();
    const entryDate = new Date();
    const performedBy = req.user?._id || undefined;
    const reasonText =
      reason != null && String(reason).trim() ? String(reason).trim() : undefined;

    const commonMeta = {
      transferId,
      from: { mobile: fromStored, name: fromName },
      to: { mobile: toStored, name: toName },
      reason: reasonText || null,
    };

    await createCustomerLedgerEntry({
      customerMobile: fromStored,
      customerName: fromName,
      refType: "ADJUSTMENT",
      refId: transferId,
      debit: amt,
      category: "Advance Transfer",
      description: `Advance transferred to ${toName || "customer"} (${toStored})${reasonText ? ` — ${reasonText}` : ""}`,
      entryDate,
      createdBy: performedBy,
      metadata: { ...commonMeta, direction: "OUT" },
      session,
    });

    await createCustomerLedgerEntry({
      customerMobile: toStored,
      customerName: toName,
      refType: "ADJUSTMENT",
      refId: transferId,
      credit: amt,
      category: "Advance Transfer",
      description: `Advance received from ${fromName || "customer"} (${fromStored})${reasonText ? ` — ${reasonText}` : ""}`,
      entryDate,
      createdBy: performedBy,
      metadata: { ...commonMeta, direction: "IN" },
      session,
    });

    const afterFrom = await getRamAgriRunningBalanceAfterMobile(fromStored, session);
    const afterTo = await getRamAgriRunningBalanceAfterMobile(toStored, session);

    await Log.create(
      [
        {
          userId: performedBy,
          modelName: "RamAgriCustomerLedgerAdvanceTransfer",
          documentId: transferId,
          operation: "CREATE",
          newState: {
            transferId,
            amount: amt,
            from: { mobile: fromStored, name: fromName },
            to: { mobile: toStored, name: toName },
            beforeFrom,
            afterFrom,
            afterTo,
            reason: reasonText || null,
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
          from: { mobile: fromStored, name: fromName, outstandingAfter: afterFrom },
          to: { mobile: toStored, name: toName, outstandingAfter: afterTo },
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

/** POST — manual ADJUSTMENT on Ram Agri customer ledger */
export const createManualRamAgriCustomerLedgerEntry = catchAsync(async (req, res, next) => {
  const {
    customerMobile: bodyMobile,
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
  const allowedModes = ["Cash", "UPI", "Cheque", "NEFT/RTGS", "Bank Transfer", "Card"];
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

  const digits = normalizeAgriCustomerMobile(bodyMobile || mobileNumber);
  if (!digits || digits.length < 10) {
    return next(new AppError("Valid customerMobile or mobileNumber is required", 400));
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const stored = await resolveRamAgriStoredMobile(digits, session);
    const last = await RamAgriCustomerLedgerEntry.findOne({ customerMobile: stored })
      .sort({ entryDate: -1, createdAt: -1 })
      .session(session)
      .lean();
    const ord = await AgriSalesOrder.findOne({
      isRamAgriProduct: true,
      customerMobile: stored,
    })
      .sort({ createdAt: -1 })
      .session(session)
      .select("customerName")
      .lean();
    const custName = (last?.customerName || ord?.customerName || "").trim();

    const manualId = new mongoose.Types.ObjectId();
    const createdBy = req.user?._id || undefined;

    const created = await createCustomerLedgerEntry({
      customerMobile: stored,
      customerName: custName,
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

    const outstandingAfter = await getRamAgriRunningBalanceAfterMobile(stored, session);

    await Log.create(
      [
        {
          userId: createdBy,
          modelName: "RamAgriCustomerLedgerManualEntry",
          documentId: manualId,
          operation: "CREATE",
          newState: {
            manualEntryId: manualId,
            ledgerEntryId: created?._id || null,
            customerMobile: stored,
            customerName: custName,
            entryType: type,
            amount: amt,
            modeOfPayment: mode,
            remark: remarkText,
            outstandingAfter,
          },
          changedFields: ["manualLedgerEntry"],
          metadata: { manualEntryId: manualId, customerMobile: stored, entryType: type, amount: amt },
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
});

/** GET — paginated list of customer mobiles that have Ram Agri ledger lines */
export const getRamAgriLedgerParties = catchAsync(async (req, res) => {
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
        customerName: { $last: "$customerName" },
        lines: {
          $push: {
            d: { $ifNull: ["$debit", 0] },
            c: { $ifNull: ["$credit", 0] },
          },
        },
        lastEntryDate: { $last: "$entryDate" },
        lineCount: { $sum: 1 },
      },
    },
    {
      $addFields: {
        outstanding: {
          $reduce: {
            input: "$lines",
            initialValue: 0,
            in: {
              $add: [
                "$$value",
                { $subtract: [{ $ifNull: ["$$this.d", 0] }, { $ifNull: ["$$this.c", 0] }] },
              ],
            },
          },
        },
      },
    },
    { $project: { lines: 0 } },
    { $sort: { lastEntryDate: -1 } },
    {
      $facet: {
        data: [{ $skip: skip }, { $limit: limit }],
        total: [{ $count: "count" }],
      },
    },
  ];

  const agg = await RamAgriCustomerLedgerEntry.aggregate(pipeline);
  const facet = agg[0] || { data: [], total: [] };
  const data = facet.data || [];
  const total = facet.total?.[0]?.count ?? 0;

  const items = data.map((r) => ({
    customerMobile: r._id,
    customerName: r.customerName || "",
    outstanding: roundMoney(Number(r.outstanding) || 0),
    lineCount: r.lineCount,
    lastEntryDate: r.lastEntryDate,
  }));

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

// ==================== CLEAR CUSTOMER LEDGER ====================

export const clearCustomerLedger = catchAsync(async (req, res, next) => {
  const { customerMobile } = req.query;

  if (!customerMobile) {
    return res.status(400).json({
      status: "Error",
      message: "customerMobile is required to clear ledger",
    });
  }

  const result = await RamAgriCustomerLedgerEntry.collection.deleteMany({
    customerMobile,
  });

  const response = generateResponse(
    "Success",
    "Customer ledger cleared successfully",
    {
      customerMobile,
      deletedCount: result.deletedCount || 0,
    },
    undefined
  );

  return res.status(200).json(response);
});


