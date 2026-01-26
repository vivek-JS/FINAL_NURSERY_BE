import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import GRN from "../models/grn.model.js";
import mongoose from "mongoose";
import RamAgriCustomerLedgerEntry from "../models/ramAgriCustomerLedger.model.js";

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


