import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";
import InventoryChangeLog from "../models/inventoryChangeLog.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import PurchaseOrder from "../models/purchaseOrder.model.js";
import Merchant from "../models/merchant.model.js";
import mongoose from "mongoose";
import { mergeAgriOldFilter } from "../utils/agriOrderEra.util.js";

// ==================== RAM AGRI SALES DASHBOARD ====================

const ORDER_STATUSES = ['PENDING', 'ACCEPTED', 'ASSIGNED', 'DISPATCHED', 'REJECTED', 'COMPLETED', 'CANCELLED'];
const PAYMENT_STATUSES = ['COLLECTED', 'PENDING', 'REJECTED'];
const LOW_STOCK_THRESHOLD = 100;

const STOCK_SORT_KEYS = {
  updated: 'stockUpdatedAt',
  crop: 'cropName',
  variety: 'varietyName',
  stock: 'currentStock',
  value: 'stockValue',
};

const getStockUpdatedAt = (variety, crop, changeLogMap) => {
  if (variety.stockUpdatedAt) return new Date(variety.stockUpdatedAt);
  const fromLog = changeLogMap.get(String(variety._id));
  if (fromLog) return new Date(fromLog);
  if (crop.updatedAt) return new Date(crop.updatedAt);
  if (crop.createdAt) return new Date(crop.createdAt);
  return new Date(0);
};

const mapVarietyForStock = (crop, variety, changeLogMap) => ({
  varietyId: variety._id,
  name: variety.name,
  currentStock: variety.currentStock || 0,
  stockValue: variety.stockValue || 0,
  averagePrice: variety.averagePrice || 0,
  primaryUnit: variety.primaryUnit,
  secondaryUnit: variety.secondaryUnit,
  conversionFactor: variety.conversionFactor || 1,
  defaultRate: variety.defaultRate,
  purchasePrice: variety.purchasePrice,
  stockUpdatedAt: getStockUpdatedAt(variety, crop, changeLogMap),
});

const sortStockItems = (items, sortKey = 'updated', sortOrder = 'desc') => {
  const field = STOCK_SORT_KEYS[sortKey] || STOCK_SORT_KEYS.updated;
  const dir = String(sortOrder).toLowerCase() === 'asc' ? 1 : -1;

  return [...items].sort((a, b) => {
    if (field === 'stockUpdatedAt') {
      const diff = new Date(a.stockUpdatedAt) - new Date(b.stockUpdatedAt);
      if (diff !== 0) return diff * dir;
      return String(a.cropName).localeCompare(String(b.cropName)) * dir;
    }
    if (field === 'currentStock' || field === 'stockValue') {
      return ((a[field] || 0) - (b[field] || 0)) * dir;
    }
    const av = String(a[field] || '').toLowerCase();
    const bv = String(b[field] || '').toLowerCase();
    return av.localeCompare(bv) * dir;
  });
};

const buildFlatStockItems = (crops, changeLogMap) => {
  const items = [];
  crops.forEach((crop) => {
    (crop.varieties || []).forEach((variety) => {
      const mapped = mapVarietyForStock(crop, variety, changeLogMap);
      items.push({
        cropId: crop._id,
        cropName: crop.cropName,
        productType: crop.productType || 'seed',
        varietyId: mapped.varietyId,
        varietyName: mapped.name,
        ...mapped,
      });
    });
  });
  return items;
};

export const getRamAgriSalesDashboard = catchAsync(async (req, res, next) => {
  const {
    startDate,
    endDate,
    cropId,
    varietyId,
    orderStatus,
    paymentStatus,
    productType,
    stockCropId,
    stockSearch,
    stockSort = 'updated',
    stockOrder = 'desc',
    isOld,
  } = req.query;

  // Parse status filters (comma-separated or single)
  const orderStatusFilter = orderStatus
    ? (Array.isArray(orderStatus) ? orderStatus : orderStatus.split(',').map((s) => s.trim()).filter(Boolean))
    : [];
  const paymentStatusFilter = paymentStatus
    ? (Array.isArray(paymentStatus) ? paymentStatus : paymentStatus.split(',').map((s) => s.trim()).filter(Boolean))
    : [];

  // Calculate date range for transactions
  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.orderDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate + 'T23:59:59.999Z'),
    };
  } else if (startDate) {
    dateFilter.orderDate = { $gte: new Date(startDate) };
  } else if (endDate) {
    dateFilter.orderDate = { $lte: new Date(endDate + 'T23:59:59.999Z') };
  }

  // Build crop/variety filter
  const cropVarietyFilter = {};
  if (cropId) cropVarietyFilter['ramAgriCropId'] = new mongoose.Types.ObjectId(cropId);
  if (varietyId) cropVarietyFilter['ramAgriVarietyId'] = new mongoose.Types.ObjectId(varietyId);

  // Combine filters for agri sales orders
  const orderFilter = mergeAgriOldFilter(
    {
      isRamAgriProduct: true,
      ...cropVarietyFilter,
      ...(Object.keys(dateFilter).length > 0 ? dateFilter : {}),
    },
    isOld
  );

  // ==================== STOCK DATA (RAM AGRI ONLY) ====================

  // Get all Ram Agri crops with varieties and units
  const crops = await RamAgriInputsProduct.find({ isActive: true })
    .populate('varieties.primaryUnit varieties.secondaryUnit')
    .lean();

  // Calculate stock summary
  const totalCrops = crops.length;
  const totalVarieties = crops.reduce((sum, crop) => sum + (crop.varieties?.length || 0), 0);

  // Calculate stock value for all varieties
  const varietiesStockValue = crops.reduce((sum, crop) => 
    sum + (crop.varieties?.reduce((vSum, v) => vSum + (v.stockValue || 0), 0) || 0), 0
  );

  // Calculate total current stock
  const varietiesCurrentStock = crops.reduce((sum, crop) => 
    sum + (crop.varieties?.reduce((vSum, v) => vSum + (v.currentStock || 0), 0) || 0), 0
  );

  // Low stock varieties (below average price threshold or custom threshold)
  const lowStockVarieties = crops.flatMap(crop => 
    (crop.varieties || []).filter(v => {
      const stock = v.currentStock || 0;
      return stock > 0 && stock < LOW_STOCK_THRESHOLD;
    })
  );

  // Out of stock varieties
  const outOfStockVarieties = crops.flatMap(crop => 
    (crop.varieties || []).filter(v => (v.currentStock || 0) === 0)
  );

  const varietyIds = crops.flatMap((crop) => (crop.varieties || []).map((v) => v._id));
  const stockChangeLogs = varietyIds.length
    ? await InventoryChangeLog.aggregate([
        {
          $match: {
            entityType: 'variety',
            entityId: { $in: varietyIds },
            'changes.field': 'currentStock',
          },
        },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: '$entityId',
            lastStockUpdate: { $first: '$createdAt' },
          },
        },
      ])
    : [];
  const stockChangeLogMap = new Map(
    stockChangeLogs.map((row) => [String(row._id), row.lastStockUpdate])
  );

  const buildStockByCrop = (cropList) =>
    cropList.map((crop) => {
      const varieties = (crop.varieties || [])
        .map((v) => mapVarietyForStock(crop, v, stockChangeLogMap))
        .sort(
          (a, b) => new Date(b.stockUpdatedAt) - new Date(a.stockUpdatedAt)
        );
      return {
        cropId: crop._id,
        cropName: crop.cropName,
        productType: crop.productType || 'seed',
        varietiesCount: varieties.length,
        totalStock: varieties.reduce((sum, v) => sum + (v.currentStock || 0), 0),
        totalValue: varieties.reduce((sum, v) => sum + (v.stockValue || 0), 0),
        varieties,
      };
    });

  const stockByCrop = buildStockByCrop(crops);

  let stockItems = buildFlatStockItems(crops, stockChangeLogMap);

  const stockProductType =
    productType === 'chemical' || productType === 'seed' || productType === 'gift'
      ? productType
      : null;
  if (stockProductType) {
    stockItems = stockItems.filter((item) => item.productType === stockProductType);
  }
  if (stockCropId && mongoose.isValidObjectId(stockCropId)) {
    const cropIdStr = String(stockCropId);
    stockItems = stockItems.filter((item) => String(item.cropId) === cropIdStr);
  }
  if (stockSearch && String(stockSearch).trim()) {
    const q = String(stockSearch).trim().toLowerCase();
    stockItems = stockItems.filter(
      (item) =>
        item.cropName?.toLowerCase().includes(q) ||
        item.varietyName?.toLowerCase().includes(q)
    );
  }

  stockItems = sortStockItems(stockItems, stockSort, stockOrder);

  // ==================== SALES DATA (RAM AGRI ORDERS ONLY) ====================

  // Get all Ram Agri sales orders
  const agriSalesOrders = await AgriSalesOrder.find(orderFilter)
    .populate('ramAgriCropId')
    .sort({ orderDate: -1 })
    .lean();

  // Filter orders by date range
  let filteredOrders = Object.keys(dateFilter).length > 0
    ? agriSalesOrders.filter(order => {
        const orderDate = new Date(order.orderDate || order.createdAt);
        const start = dateFilter.orderDate?.$gte ? new Date(dateFilter.orderDate.$gte) : null;
        const end = dateFilter.orderDate?.$lte ? new Date(dateFilter.orderDate.$lte) : null;
        if (start && orderDate < start) return false;
        if (end && orderDate > end) return false;
        return true;
      })
    : agriSalesOrders;

  // Status counts (always from full date-filtered set, no status filter)
  const orderStatusCounts = ORDER_STATUSES.reduce((acc, s) => {
    acc[s] = filteredOrders.filter((o) => (o.orderStatus || 'PENDING') === s).length;
    return acc;
  }, {});
  let paymentStatusCounts = { COLLECTED: 0, PENDING: 0, REJECTED: 0 };
  filteredOrders.forEach((o) => {
    (o.payment || []).forEach((p) => {
      const ps = p.paymentStatus || 'PENDING';
      if (paymentStatusCounts[ps] !== undefined) paymentStatusCounts[ps] += 1;
    });
  });

  // Apply order status filter
  if (orderStatusFilter.length > 0) {
    const set = new Set(orderStatusFilter);
    filteredOrders = filteredOrders.filter((o) => set.has(o.orderStatus || 'PENDING'));
  }
  // Apply payment status filter (orders that have at least one payment with given status)
  if (paymentStatusFilter.length > 0) {
    const set = new Set(paymentStatusFilter);
    filteredOrders = filteredOrders.filter((o) => {
      return (o.payment || []).some((p) => set.has(p.paymentStatus || 'PENDING'));
    });
  }

  // Extract all payments (from status-filtered orders)
  const allPayments = [];
  filteredOrders.forEach(order => {
    if (order.payment && Array.isArray(order.payment)) {
      order.payment.forEach(payment => {
        allPayments.push({
          ...payment,
          orderId: order._id,
          orderNumber: order.orderNumber || order._id.toString(),
          orderDate: order.orderDate || order.createdAt,
          customerName: order.customerName || 'Unknown',
          customerMobile: order.customerMobile || '',
          cropId: order.ramAgriCropId?._id || order.ramAgriCropId,
          cropName: order.ramAgriCropName || order.ramAgriCropId?.cropName,
          varietyId: order.ramAgriVarietyId,
          varietyName: order.ramAgriVarietyName,
          quantity: order.quantity || 0,
          rate: order.rate || 0,
          totalAmount: order.totalAmount || 0,
        });
      });
    }
  });

  // Calculate sales summary
  const totalOrders = filteredOrders.length;
  const totalOrderValue = filteredOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
  const totalPaidAmount = allPayments
    .filter(p => p.paymentStatus === 'COLLECTED')
    .reduce((sum, p) => sum + (p.paidAmount || 0), 0);
  const totalPendingAmount = allPayments
    .filter(p => p.paymentStatus === 'PENDING')
    .reduce((sum, p) => sum + (p.paidAmount || 0), 0);
  const outstandingBalance = totalOrderValue - totalPaidAmount;

  // Opening balance (orders before start date)
  let openingBalance = 0;
  if (startDate) {
    const openingStartDate = new Date(startDate);
    const openingOrders = agriSalesOrders.filter(order => {
      const orderDate = new Date(order.orderDate || order.createdAt);
      return orderDate < openingStartDate;
    });

    openingBalance = openingOrders.reduce((sum, o) => {
      const paid = (o.payment || [])
        .filter(p => p.paymentStatus === 'COLLECTED')
        .reduce((pSum, p) => pSum + (p.paidAmount || 0), 0);
      return sum + ((o.totalAmount || 0) - paid);
    }, 0);
  }

  // Closing balance
  const closingBalance = openingBalance + outstandingBalance;

  // ==================== VARIETY-WISE SALES ====================

  const varietyWiseSales = {};
  filteredOrders.forEach(order => {
    const cropId = order.ramAgriCropId?._id?.toString() || order.ramAgriCropId?.toString() || '';
    const varietyId = order.ramAgriVarietyId?.toString() || '';
    const key = `${cropId}_${varietyId}`;

    if (!key || !varietyId) return;

    if (!varietyWiseSales[key]) {
      varietyWiseSales[key] = {
        cropId,
        cropName: order.ramAgriCropName || order.ramAgriCropId?.cropName || 'Unknown',
        varietyId,
        varietyName: order.ramAgriVarietyName || 'Unknown',
        totalQuantity: 0,
        totalValue: 0,
        totalPaid: 0,
        outstanding: 0,
        orderCount: 0,
        orders: [],
      };
    }

    const paid = (order.payment || [])
      .filter(p => p.paymentStatus === 'COLLECTED')
      .reduce((sum, p) => sum + (p.paidAmount || 0), 0);

    varietyWiseSales[key].totalQuantity += order.quantity || 0;
    varietyWiseSales[key].totalValue += order.totalAmount || 0;
    varietyWiseSales[key].totalPaid += paid;
    varietyWiseSales[key].outstanding += (order.totalAmount || 0) - paid;
    varietyWiseSales[key].orderCount += 1;
    varietyWiseSales[key].orders.push({
      orderId: order._id,
      orderNumber: order.orderNumber || order._id.toString(),
      orderDate: order.orderDate || order.createdAt,
      customerName: order.customerName || 'Unknown',
      customerMobile: order.customerMobile || '',
      customerVillage: order.customerVillage || '',
      quantity: order.quantity || 0,
      rate: order.rate || 0,
      amount: order.totalAmount || 0,
      paid,
      outstanding: (order.totalAmount || 0) - paid,
      orderStatus: order.orderStatus || 'PENDING',
      paymentStatus: order.paymentStatus || 'PENDING',
    });
  });

  // ==================== CROP-WISE SALES ====================

  const cropWiseSales = {};
  filteredOrders.forEach(order => {
    const cropId = order.ramAgriCropId?._id?.toString() || order.ramAgriCropId?.toString() || '';
    const cropName = order.ramAgriCropName || order.ramAgriCropId?.cropName || 'Unknown';

    if (!cropId) return;

    if (!cropWiseSales[cropId]) {
      cropWiseSales[cropId] = {
        cropId,
        cropName,
        totalQuantity: 0,
        totalValue: 0,
        totalPaid: 0,
        outstanding: 0,
        orderCount: 0,
        varietyCount: new Set(),
      };
    }

    const paid = (order.payment || [])
      .filter(p => p.paymentStatus === 'COLLECTED')
      .reduce((sum, p) => sum + (p.paidAmount || 0), 0);

    cropWiseSales[cropId].totalQuantity += order.quantity || 0;
    cropWiseSales[cropId].totalValue += order.totalAmount || 0;
    cropWiseSales[cropId].totalPaid += paid;
    cropWiseSales[cropId].outstanding += (order.totalAmount || 0) - paid;
    cropWiseSales[cropId].orderCount += 1;
    if (order.ramAgriVarietyId) {
      cropWiseSales[cropId].varietyCount.add(order.ramAgriVarietyId.toString());
    }
  });

  // Convert varietyCount Set to number
  Object.keys(cropWiseSales).forEach(cropId => {
    cropWiseSales[cropId].varietyCount = cropWiseSales[cropId].varietyCount.size;
  });

  // ==================== MERCHANT-WISE PURCHASES (RAM AGRI) ====================

  // Get all merchants with linked Ram Agri products
  const merchants = await Merchant.find({
    isActive: true,
    linkedProducts: { $exists: true, $ne: [] },
  }).lean();

  // Build date filter for purchase orders
  const poDateFilter = {};
  if (startDate && endDate) {
    poDateFilter.$gte = new Date(startDate);
    poDateFilter.$lte = new Date(endDate + 'T23:59:59.999Z');
  } else if (startDate) {
    poDateFilter.$gte = new Date(startDate);
  } else if (endDate) {
    poDateFilter.$lte = new Date(endDate + 'T23:59:59.999Z');
  }

  // Get all purchase orders with Ram Agri products
  const purchaseOrders = await PurchaseOrder.find({
    'items.isRamAgriProduct': true,
    ...(Object.keys(poDateFilter).length > 0 ? { poDate: poDateFilter } : {}),
  })
    .populate('supplier', 'name code phone')
    .sort({ poDate: -1 })
    .lean();

  const filteredPurchaseOrders = purchaseOrders;

  const merchantWisePurchases = {};
  filteredPurchaseOrders.forEach(po => {
    // Check if supplier is a merchant (has linkedProducts) or use supplier ID directly
    const merchantId = po.supplier?._id?.toString() || po.supplier?.toString() || po.supplier;
    const merchant = merchants.find(m => m._id.toString() === merchantId);
    
    // Only include merchants who have linkedProducts
    if (merchant && merchant.linkedProducts && merchant.linkedProducts.length > 0) {
      if (!merchantWisePurchases[merchantId]) {
        merchantWisePurchases[merchantId] = {
          merchantId,
          merchantName: merchant.name || po.supplier?.name || 'Unknown',
          merchantCode: merchant.code || po.supplier?.code || '',
          merchantPhone: merchant.phone || po.supplier?.phone || '',
          totalPOs: 0,
          totalQuantity: 0,
          totalValue: 0,
          paidAmount: 0,
          outstanding: 0,
          linkedProductsCount: merchant.linkedProducts?.length || 0,
        };
      }

      // Get only Ram Agri items
      const ramAgriItems = po.items.filter(item => item.isRamAgriProduct);
      const poValue = ramAgriItems.reduce((sum, item) => sum + (item.amount || 0), 0);
      const poQuantity = ramAgriItems.reduce((sum, item) => sum + (item.quantity || 0), 0);

      merchantWisePurchases[merchantId].totalPOs += 1;
      merchantWisePurchases[merchantId].totalQuantity += poQuantity;
      merchantWisePurchases[merchantId].totalValue += poValue;
      merchantWisePurchases[merchantId].paidAmount += po.paidAmount || 0;
      merchantWisePurchases[merchantId].outstanding += (poValue - (po.paidAmount || 0));
    }
  });

  // ==================== CUSTOMER-WISE SALES ====================

  const customerWiseSales = {};
  filteredOrders.forEach(order => {
    const customerName = order.customerName || 'Unknown';
    const customerMobile = order.customerMobile || '';
    const key = `${customerName}_${customerMobile}`;

    if (!customerWiseSales[key]) {
      customerWiseSales[key] = {
        customerName,
        customerMobile,
        customerVillage: order.customerVillage || '',
        customerTaluka: order.customerTaluka || '',
        customerDistrict: order.customerDistrict || '',
        totalOrders: 0,
        totalValue: 0,
        totalPaid: 0,
        outstanding: 0,
        orders: [],
      };
    }

    const paid = (order.payment || [])
      .filter(p => p.paymentStatus === 'COLLECTED')
      .reduce((sum, p) => sum + (p.paidAmount || 0), 0);

    customerWiseSales[key].totalOrders += 1;
    customerWiseSales[key].totalValue += order.totalAmount || 0;
    customerWiseSales[key].totalPaid += paid;
    customerWiseSales[key].outstanding += (order.totalAmount || 0) - paid;
    customerWiseSales[key].orders.push({
      orderId: order._id,
      orderNumber: order.orderNumber || order._id.toString(),
      orderDate: order.orderDate || order.createdAt,
      cropName: order.ramAgriCropName || order.ramAgriCropId?.cropName || 'Unknown',
      varietyName: order.ramAgriVarietyName || 'Unknown',
      quantity: order.quantity || 0,
      amount: order.totalAmount || 0,
      paid,
      outstanding: (order.totalAmount || 0) - paid,
    });
  });

  // ==================== TRANSACTIONS (ALL RAM AGRI ORDERS) ====================

  const allTransactions = filteredOrders.map(order => {
    const paid = (order.payment || [])
      .filter(p => p.paymentStatus === 'COLLECTED')
      .reduce((sum, p) => sum + (p.paidAmount || 0), 0);

    return {
      orderId: order._id,
      orderNumber: order.orderNumber || order._id.toString(),
      orderDate: order.orderDate || order.createdAt,
      cropId: order.ramAgriCropId?._id || order.ramAgriCropId,
      cropName: order.ramAgriCropName || order.ramAgriCropId?.cropName || 'Unknown',
      varietyId: order.ramAgriVarietyId,
      varietyName: order.ramAgriVarietyName || 'Unknown',
      customerName: order.customerName || 'Unknown',
      customerMobile: order.customerMobile || '',
      customerVillage: order.customerVillage || '',
      quantity: order.quantity || 0,
      rate: order.rate || 0,
      totalAmount: order.totalAmount || 0,
      paid,
      outstanding: (order.totalAmount || 0) - paid,
      orderStatus: order.orderStatus || 'PENDING',
      paymentStatus: order.paymentStatus || 'PENDING',
      payments: order.payment || [],
    };
  });

  // ==================== PAYMENT STATUS BREAKDOWN ====================

  const paymentStatusBreakdown = {
    collected: allPayments.filter(p => p.paymentStatus === 'COLLECTED').length,
    pending: allPayments.filter(p => p.paymentStatus === 'PENDING').length,
    rejected: allPayments.filter(p => p.paymentStatus === 'REJECTED').length,
  };

  // ==================== DAILY SALES TREND ====================

  const dailySales = {};
  filteredOrders.forEach(order => {
    const date = new Date(order.orderDate || order.createdAt).toISOString().split('T')[0];
    if (!dailySales[date]) {
      dailySales[date] = { date, sales: 0, orders: 0, quantity: 0 };
    }
    dailySales[date].sales += order.totalAmount || 0;
    dailySales[date].orders += 1;
    dailySales[date].quantity += order.quantity || 0;
  });

  // ==================== PREPARE RESPONSE ====================

  const responseData = {
    statusCounts: {
      orderStatus: orderStatusCounts,
      paymentStatus: paymentStatusCounts,
    },
    summary: {
      stock: {
        totalCrops,
        totalVarieties,
        totalStockValue: varietiesStockValue,
        totalCurrentStock: varietiesCurrentStock,
        lowStockCount: lowStockVarieties.length,
        outOfStockCount: outOfStockVarieties.length,
      },
      sales: {
        totalOrders,
        totalOrderValue,
        totalPaidAmount,
        totalPendingAmount,
        outstandingBalance,
        openingBalance,
        closingBalance,
      },
    },
    stock: {
      stockByCrop,
      stockItems,
      stockSort: {
        sortBy: stockSort,
        sortOrder: String(stockOrder).toLowerCase() === 'asc' ? 'asc' : 'desc',
      },
      lowStockVarieties: lowStockVarieties.slice(0, 50).map(v => ({
        varietyId: v._id,
        name: v.name,
        currentStock: v.currentStock || 0,
        averagePrice: v.averagePrice || 0,
      })),
      outOfStockVarieties: outOfStockVarieties.slice(0, 50).map(v => ({
        varietyId: v._id,
        name: v.name,
      })),
    },
    sales: {
      varietyWiseSales: Object.values(varietyWiseSales)
        .sort((a, b) => b.totalValue - a.totalValue)
        .slice(0, 100),
      cropWiseSales: Object.values(cropWiseSales)
        .sort((a, b) => b.totalValue - a.totalValue)
        .slice(0, 50),
      merchantWisePurchases: Object.values(merchantWisePurchases)
        .sort((a, b) => b.totalValue - a.totalValue)
        .slice(0, 100),
      customerWiseSales: Object.values(customerWiseSales)
        .sort((a, b) => b.outstanding - a.outstanding)
        .slice(0, 100),
      dailySales: Object.values(dailySales)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-30), // Last 30 days
      paymentStatusBreakdown,
    },
    transactions: allTransactions
      .sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate))
      .slice(0, 200), // Last 200 transactions
    payments: allPayments
      .sort((a, b) => new Date(b.paymentDate || b.orderDate) - new Date(a.paymentDate || a.orderDate))
      .slice(0, 100), // Last 100 payments
  };

  const response = generateResponse(
    "Success",
    "Ram Agri Sales Dashboard data fetched successfully",
    responseData,
    undefined
  );

  return res.status(200).json(response);
});

