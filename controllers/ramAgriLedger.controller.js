import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import PurchaseOrder from "../models/purchaseOrder.model.js";
import GRN from "../models/grn.model.js";
import mongoose from "mongoose";

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
  if (startDate && endDate) {
    dateFilter.$gte = new Date(startDate);
    dateFilter.$lte = new Date(endDate + 'T23:59:59.999Z');
  } else if (startDate) {
    dateFilter.$gte = new Date(startDate);
  } else if (endDate) {
    dateFilter.$lte = new Date(endDate + 'T23:59:59.999Z');
  }

  // Get all purchase orders (CREDIT - Stock additions)
  const purchaseOrders = await PurchaseOrder.find({
    'items.isRamAgriProduct': true,
    'items.ramAgriCropId': new mongoose.Types.ObjectId(cropId),
    'items.ramAgriVarietyId': new mongoose.Types.ObjectId(varietyId),
    ...(Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {}),
  })
    .populate('supplier', 'name code')
    .sort({ createdAt: -1 })
    .lean();

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

  // Get all sales orders (DEBIT - Stock deductions)
  const salesOrders = await AgriSalesOrder.find({
    isRamAgriProduct: true,
    ramAgriCropId: new mongoose.Types.ObjectId(cropId),
    ramAgriVarietyId: new mongoose.Types.ObjectId(varietyId),
    ...(Object.keys(dateFilter).length > 0 ? { orderDate: dateFilter } : {}),
  })
    .sort({ orderDate: -1 })
    .lean();

  // Build ledger entries
  const ledgerEntries = [];

  // Add Purchase Orders (CREDIT)
  purchaseOrders.forEach(po => {
    const item = po.items.find(i => 
      i.isRamAgriProduct && 
      i.ramAgriCropId?.toString() === cropId &&
      i.ramAgriVarietyId?.toString() === varietyId
    );
    if (item) {
      ledgerEntries.push({
        date: po.createdAt,
        type: 'CREDIT',
        category: 'Purchase Order',
        reference: po.orderNumber || po._id.toString(),
        description: `Purchase from ${po.supplier?.name || 'Supplier'}`,
        quantity: item.quantity || 0,
        unit: item.unit || null,
        rate: item.rate || 0,
        amount: item.amount || 0,
        balance: 0, // Will calculate later
        details: {
          poId: po._id,
          supplier: po.supplier,
          status: po.status,
        },
      });
    }
  });

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

  // Add Sales Orders (DEBIT)
  salesOrders.forEach(order => {
    ledgerEntries.push({
      date: order.orderDate || order.createdAt,
      type: 'DEBIT',
      category: 'Sale',
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
      },
    });
  });

  // Sort by date
  ledgerEntries.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Calculate running balance
  let runningBalance = variety.currentStock || 0;
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

  // Calculate summary
  const totalCredit = ledgerEntries
    .filter(e => e.type === 'CREDIT')
    .reduce((sum, e) => sum + (e.quantity || 0), 0);
  const totalDebit = ledgerEntries
    .filter(e => e.type === 'DEBIT')
    .reduce((sum, e) => sum + (e.quantity || 0), 0);
  const openingStock = (variety.currentStock || 0) - totalCredit + totalDebit;

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

  // Date filter
  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.$gte = new Date(startDate);
    dateFilter.$lte = new Date(endDate + 'T23:59:59.999Z');
  } else if (startDate) {
    dateFilter.$gte = new Date(startDate);
  } else if (endDate) {
    dateFilter.$lte = new Date(endDate + 'T23:59:59.999Z');
  }

  // Build customer filter
  const customerFilter = {};
  if (customerMobile) customerFilter.customerMobile = customerMobile;
  if (customerName) customerFilter.customerName = new RegExp(customerName, 'i');
  // Note: customerId is accepted but not used in query since AgriSalesOrder doesn't store customerId
  // It's kept for API compatibility

  // Get all orders for this customer (no limit - return all entries)
  const orders = await AgriSalesOrder.find({
    isRamAgriProduct: true,
    ...customerFilter,
    ...(Object.keys(dateFilter).length > 0 ? { orderDate: dateFilter } : {}),
  })
    .populate('ramAgriCropId', 'cropName')
    .sort({ orderDate: -1 })
    .lean();

  if (orders.length === 0) {
    return res.status(404).json({
      status: "Error",
      message: "No orders found for this customer",
    });
  }

  // Get customer details from first order
  const customer = {
    name: orders[0].customerName || 'Unknown',
    mobile: orders[0].customerMobile || '',
    village: orders[0].customerVillage || '',
    taluka: orders[0].customerTaluka || '',
    district: orders[0].customerDistrict || '',
  };

  // Build ledger entries
  const ledgerEntries = [];

  orders.forEach(order => {
    // DEBIT: Order placed
    ledgerEntries.push({
      date: order.orderDate || order.createdAt,
      type: 'DEBIT',
      category: 'Order',
      reference: order.orderNumber || order._id.toString(),
      description: `Order: ${order.ramAgriCropName || order.ramAgriCropId?.cropName || 'Unknown'} - ${order.ramAgriVarietyName || 'Unknown'}`,
      quantity: order.quantity || 0,
      amount: order.totalAmount || 0,
      balance: 0,
      details: {
        orderId: order._id,
        cropId: order.ramAgriCropId?._id || order.ramAgriCropId,
        cropName: order.ramAgriCropName || order.ramAgriCropId?.cropName,
        varietyId: order.ramAgriVarietyId,
        varietyName: order.ramAgriVarietyName,
        orderStatus: order.orderStatus,
        paymentStatus: order.paymentStatus,
      },
    });

    // CREDIT: Payments
    if (order.payment && Array.isArray(order.payment)) {
      order.payment.forEach(payment => {
        ledgerEntries.push({
          date: payment.paymentDate || order.orderDate || order.createdAt,
          type: 'CREDIT',
          category: 'Payment',
          reference: order.orderNumber || order._id.toString(),
          description: `Payment via ${payment.modeOfPayment || 'N/A'}`,
          amount: payment.paidAmount || 0,
          balance: 0,
          details: {
            paymentId: payment._id,
            orderId: order._id,
            paymentStatus: payment.paymentStatus,
            modeOfPayment: payment.modeOfPayment,
            bankName: payment.bankName,
            remark: payment.remark,
          },
        });
      });
    }
  });

  // Sort by date
  ledgerEntries.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Calculate running balance (outstanding)
  let runningBalance = 0;
  const entriesWithBalance = ledgerEntries.map(entry => {
    if (entry.type === 'CREDIT') {
      runningBalance -= entry.amount; // Payment reduces outstanding
    } else {
      runningBalance += entry.amount; // Order increases outstanding
    }
    return {
      ...entry,
      balance: runningBalance,
    };
  }).reverse(); // Reverse to show latest first

  // Calculate summary
  const totalDebit = ledgerEntries
    .filter(e => e.type === 'DEBIT')
    .reduce((sum, e) => sum + (e.amount || 0), 0);
  const totalCredit = ledgerEntries
    .filter(e => e.type === 'CREDIT')
    .reduce((sum, e) => sum + (e.amount || 0), 0);
  const outstanding = totalDebit - totalCredit;
  const openingBalance = outstanding - runningBalance;

  const response = generateResponse(
    "Success",
    "Customer ledger fetched successfully",
    {
      customer,
      summary: {
        totalOrders: orders.length,
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


