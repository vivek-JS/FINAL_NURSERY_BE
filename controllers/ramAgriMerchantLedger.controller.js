import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import Merchant from "../models/merchant.model.js";
import PurchaseOrder from "../models/purchaseOrder.model.js";
import GRN from "../models/grn.model.js";
import mongoose from "mongoose";

// ==================== MERCHANT LEDGER (RAM AGRI) ====================

export const getMerchantLedger = catchAsync(async (req, res, next) => {
  const { merchantId, startDate, endDate } = req.query;

  if (!merchantId) {
    return res.status(400).json({
      status: "Error",
      message: "Merchant ID is required",
    });
  }

  // Get merchant details
  const merchant = await Merchant.findById(merchantId).lean();
  if (!merchant) {
    return res.status(404).json({
      status: "Error",
      message: "Merchant not found",
    });
  }

  // Check if merchant has linked Ram Agri products
  if (!merchant.linkedProducts || merchant.linkedProducts.length === 0) {
    return res.status(404).json({
      status: "Error",
      message: "Merchant has no linked Ram Agri products",
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

  // Get all purchase orders for this merchant with Ram Agri products (DEBIT - Orders placed)
  const purchaseOrders = await PurchaseOrder.find({
    supplier: new mongoose.Types.ObjectId(merchantId),
    'items.isRamAgriProduct': true,
    ...(Object.keys(dateFilter).length > 0 ? { poDate: dateFilter } : {}),
  })
    .sort({ poDate: -1 })
    .lean();

  // Get all GRNs for this merchant with Ram Agri products (DEBIT - Goods received)
  const grns = await GRN.find({
    supplier: new mongoose.Types.ObjectId(merchantId),
    'items.isRamAgriProduct': true,
    ...(Object.keys(dateFilter).length > 0 ? { grnDate: dateFilter } : {}),
  })
    .populate('purchaseOrder', 'orderNumber poDate')
    .sort({ grnDate: -1 })
    .lean();

  // Build ledger entries
  const ledgerEntries = [];

  // Add Purchase Orders (DEBIT - Orders placed to merchant)
  purchaseOrders.forEach(po => {
    // Get only Ram Agri items
    const ramAgriItems = po.items.filter(item => item.isRamAgriProduct);
    
    if (ramAgriItems.length > 0) {
      // Group by date or create single entry per PO
      ramAgriItems.forEach(item => {
        ledgerEntries.push({
          date: po.poDate || po.createdAt,
          type: 'DEBIT',
          category: 'Purchase Order',
          reference: po.poNumber || po._id.toString(),
          description: `PO: ${item.ramAgriCropName || 'Unknown'} - ${item.ramAgriVarietyName || 'Unknown'}`,
          quantity: item.quantity || 0,
          unit: item.unit || null,
          rate: item.rate || 0,
          amount: item.amount || 0,
          balance: 0,
          details: {
            poId: po._id,
            poNumber: po.poNumber,
            status: po.status,
            paymentStatus: po.paymentStatus,
            cropId: item.ramAgriCropId,
            cropName: item.ramAgriCropName,
            varietyId: item.ramAgriVarietyId,
            varietyName: item.ramAgriVarietyName,
          },
        });
      });
    }
  });

  // Add GRNs (DEBIT - Actual goods received from merchant)
  grns.forEach(grn => {
    // Get only Ram Agri items
    const ramAgriItems = grn.items.filter(item => item.isRamAgriProduct);
    
    if (ramAgriItems.length > 0) {
      ramAgriItems.forEach(item => {
        ledgerEntries.push({
          date: grn.grnDate || grn.createdAt,
          type: 'DEBIT',
          category: 'GRN',
          reference: grn.grnNumber || grn._id.toString(),
          description: `GRN: ${item.ramAgriCropName || 'Unknown'} - ${item.ramAgriVarietyName || 'Unknown'}`,
          quantity: item.acceptedQuantity || item.quantity || 0,
          unit: item.unit || null,
          rate: item.rate || 0,
          amount: item.amount || 0,
          balance: 0,
          details: {
            grnId: grn._id,
            grnNumber: grn.grnNumber,
            poNumber: grn.purchaseOrder?.orderNumber || grn.purchaseOrder?.poNumber,
            status: grn.status,
            cropId: item.ramAgriCropId,
            cropName: item.ramAgriCropName,
            varietyId: item.ramAgriVarietyId,
            varietyName: item.ramAgriVarietyName,
          },
        });
      });
    }
  });

  // TODO: Add payment entries when payment system is implemented for purchase orders
  // For now, we'll calculate based on paymentStatus from PO

  // Sort by date
  ledgerEntries.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Calculate running balance (outstanding to merchant)
  let runningBalance = 0;
  const entriesWithBalance = ledgerEntries.map(entry => {
    if (entry.type === 'DEBIT') {
      runningBalance += entry.amount; // Order increases outstanding
    } else {
      runningBalance -= entry.amount; // Payment reduces outstanding
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

  // Get merchant summary from purchase orders
  const totalPOs = purchaseOrders.length;
  const totalGRNs = grns.length;
  
  // Calculate total quantity ordered
  const totalQuantity = purchaseOrders.reduce((sum, po) => {
    const ramAgriItems = po.items.filter(item => item.isRamAgriProduct);
    return sum + ramAgriItems.reduce((itemSum, item) => itemSum + (item.quantity || 0), 0);
  }, 0);

  // Calculate paid amount from purchase orders
  const paidAmount = purchaseOrders.reduce((sum, po) => sum + (po.paidAmount || 0), 0);

  const response = generateResponse(
    "Success",
    "Merchant ledger fetched successfully",
    {
      merchant: {
        merchantId: merchant._id,
        name: merchant.name,
        code: merchant.code,
        phone: merchant.phone,
        email: merchant.email,
        address: merchant.address,
        linkedProductsCount: merchant.linkedProducts?.length || 0,
      },
      summary: {
        totalPOs,
        totalGRNs,
        totalQuantity,
        totalDebit,
        totalCredit,
        paidAmount,
        outstanding,
      },
      entries: entriesWithBalance,
    },
    undefined
  );

  return res.status(200).json(response);
});


