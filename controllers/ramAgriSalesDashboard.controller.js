import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import PurchaseOrder from "../models/purchaseOrder.model.js";
import Merchant from "../models/merchant.model.js";
import mongoose from "mongoose";

// ==================== RAM AGRI SALES DASHBOARD ====================

export const getRamAgriSalesDashboard = catchAsync(async (req, res, next) => {
  const { startDate, endDate, cropId, varietyId } = req.query;

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
  const orderFilter = {
    isRamAgriProduct: true,
    ...cropVarietyFilter,
    ...(Object.keys(dateFilter).length > 0 ? dateFilter : {}),
  };

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
      return stock > 0 && stock < 100; // Custom threshold
    })
  );

  // Out of stock varieties
  const outOfStockVarieties = crops.flatMap(crop => 
    (crop.varieties || []).filter(v => (v.currentStock || 0) === 0)
  );

  // Stock by crop
  const stockByCrop = crops.map(crop => ({
    cropId: crop._id,
    cropName: crop.cropName,
    varietiesCount: crop.varieties?.length || 0,
    totalStock: crop.varieties?.reduce((sum, v) => sum + (v.currentStock || 0), 0) || 0,
    totalValue: crop.varieties?.reduce((sum, v) => sum + (v.stockValue || 0), 0) || 0,
    varieties: crop.varieties?.map(v => ({
      varietyId: v._id,
      name: v.name,
      currentStock: v.currentStock || 0,
      stockValue: v.stockValue || 0,
      averagePrice: v.averagePrice || 0,
      primaryUnit: v.primaryUnit,
      secondaryUnit: v.secondaryUnit,
      conversionFactor: v.conversionFactor || 1,
      defaultRate: v.defaultRate,
      purchasePrice: v.purchasePrice,
    })) || [],
  }));

  // ==================== SALES DATA (RAM AGRI ORDERS ONLY) ====================

  // Get all Ram Agri sales orders
  const agriSalesOrders = await AgriSalesOrder.find({
    isRamAgriProduct: true,
    ...cropVarietyFilter,
  })
    .populate('ramAgriCropId')
    .sort({ orderDate: -1 })
    .lean();

  // Filter orders by date range
  const filteredOrders = Object.keys(dateFilter).length > 0
    ? agriSalesOrders.filter(order => {
        const orderDate = new Date(order.orderDate || order.createdAt);
        const start = dateFilter.orderDate?.$gte ? new Date(dateFilter.orderDate.$gte) : null;
        const end = dateFilter.orderDate?.$lte ? new Date(dateFilter.orderDate.$lte) : null;
        if (start && orderDate < start) return false;
        if (end && orderDate > end) return false;
        return true;
      })
    : agriSalesOrders;

  // Extract all payments
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

