import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import { InventoryProduct } from "../models/inventory.model.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import SellOrder from "../models/sellOrder.model.js";
import mongoose from "mongoose";

// ==================== CEO DASHBOARD ====================

export const getCEODashboard = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;

  // Calculate date range for ledger data
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

  // ==================== STOCK DATA ====================

  // Get all products
  const products = await InventoryProduct.find({ isActive: true })
    .populate('supplier')
    .lean();

  // Get all Ram Agri crops with varieties
  const crops = await RamAgriInputsProduct.find({ isActive: true })
    .populate('varieties.primaryUnit varieties.secondaryUnit')
    .lean();

  // Calculate stock summary
  const totalProducts = products.length;
  const totalCrops = crops.length;
  const totalVarieties = crops.reduce((sum, crop) => sum + (crop.varieties?.length || 0), 0);

  // Calculate product stock value (costPrice * currentStock)
  const productsStockValue = products.reduce((sum, p) => {
    const costPrice = p.costPrice || 0;
    const currentStock = p.currentStock || 0;
    return sum + (costPrice * currentStock);
  }, 0);

  // Calculate Ram Agri variety stock value
  const varietiesStockValue = crops.reduce((sum, crop) => 
    sum + (crop.varieties?.reduce((vSum, v) => vSum + (v.stockValue || 0), 0) || 0), 0
  );

  const totalStockValue = productsStockValue + varietiesStockValue;

  // Calculate total current stock
  const productsCurrentStock = products.reduce((sum, p) => sum + (p.currentStock || 0), 0);
  const varietiesCurrentStock = crops.reduce((sum, crop) => 
    sum + (crop.varieties?.reduce((vSum, v) => vSum + (v.currentStock || 0), 0) || 0), 0
  );
  const totalCurrentStock = productsCurrentStock + varietiesCurrentStock;

  // Low stock products
  const lowStockProducts = products.filter(p => {
    const currentStock = p.currentStock || 0;
    const minStock = p.minStockLevel || 0;
    return currentStock <= minStock && currentStock > 0;
  });

  // Out of stock
  const outOfStockProducts = products.filter(p => (p.currentStock || 0) === 0);
  const outOfStockVarieties = crops.flatMap(crop => 
    (crop.varieties || []).filter(v => (v.currentStock || 0) === 0)
  );
  const outOfStockCount = outOfStockProducts.length + outOfStockVarieties.length;

  // Stock by category
  const stockByCategory = {};
  products.forEach(product => {
    const category = product.category || 'Other';
    if (!stockByCategory[category]) {
      stockByCategory[category] = {
        category,
        totalStock: 0,
        totalValue: 0,
        productCount: 0,
      };
    }
    const productStockValue = (product.costPrice || 0) * (product.currentStock || 0);
    stockByCategory[category].totalStock += product.currentStock || 0;
    stockByCategory[category].totalValue += productStockValue;
    stockByCategory[category].productCount += 1;
  });

  // Add Ram Agri as a category
  const ramAgriTotalStock = crops.reduce((sum, crop) => 
    sum + (crop.varieties?.reduce((vSum, v) => vSum + (v.currentStock || 0), 0) || 0), 0
  );
  const ramAgriTotalValue = crops.reduce((sum, crop) => 
    sum + (crop.varieties?.reduce((vSum, v) => vSum + (v.stockValue || 0), 0) || 0), 0
  );

  stockByCategory['Ram Agri Inputs'] = {
    category: 'Ram Agri Inputs',
    totalStock: ramAgriTotalStock,
    totalValue: ramAgriTotalValue,
    productCount: totalVarieties,
  };

  // ==================== LEDGER DATA ====================

  // Get all agri sales orders
  const agriSalesOrders = await AgriSalesOrder.find()
    .populate('productId')
    .populate('ramAgriCropId')
    .lean();

  // Get all sell orders
  const sellOrders = await SellOrder.find()
    .populate('items.product')
    .lean();

  // Filter orders by date range
  const filteredAgriSales = Object.keys(dateFilter).length > 0
    ? agriSalesOrders.filter(order => {
        const orderDate = new Date(order.orderDate || order.createdAt);
        const start = dateFilter.orderDate?.$gte ? new Date(dateFilter.orderDate.$gte) : null;
        const end = dateFilter.orderDate?.$lte ? new Date(dateFilter.orderDate.$lte) : null;
        if (start && orderDate < start) return false;
        if (end && orderDate > end) return false;
        return true;
      })
    : agriSalesOrders;

  const filteredSellOrders = Object.keys(dateFilter).length > 0
    ? sellOrders.filter(order => {
        const orderDate = new Date(order.orderDate || order.createdAt);
        const start = dateFilter.orderDate?.$gte ? new Date(dateFilter.orderDate.$gte) : null;
        const end = dateFilter.orderDate?.$lte ? new Date(dateFilter.orderDate.$lte) : null;
        if (start && orderDate < start) return false;
        if (end && orderDate > end) return false;
        return true;
      })
    : sellOrders;

  const allOrders = [...filteredAgriSales, ...filteredSellOrders];

  // Extract all payments
  const allPayments = [];
  allOrders.forEach(order => {
    if (order.payment && Array.isArray(order.payment)) {
      order.payment.forEach(payment => {
        allPayments.push({
          ...payment,
          orderNumber: order.orderNumber || order._id.toString(),
          orderDate: order.orderDate || order.createdAt,
          customerName: order.customerName || order.buyerName || 'Unknown',
          customerMobile: order.customerMobile || order.buyerMobile || '',
        });
      });
    }
  });

  // Calculate ledger totals
  const totalOrders = allOrders.length;
  const totalOrderValue = allOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
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
    const openingOrders = [...agriSalesOrders, ...sellOrders].filter(order => {
      const orderDate = new Date(order.orderDate || order.createdAt);
      return orderDate < openingStartDate;
    });

    openingBalance = openingOrders.reduce((sum, o) => {
      const paid = (o.payment || [])
        .filter(p => p.paymentStatus === 'COLLECTED')
        .reduce((pSum, p) => pSum + (p.paidAmount || 0), 0);
      
      // Get order total
      let orderTotal = o.totalAmount || 0;
      if (!orderTotal && o.items && Array.isArray(o.items)) {
        orderTotal = o.items.reduce((itemSum, item) => itemSum + (item.amount || 0), 0);
      }
      
      return sum + (orderTotal - paid);
    }, 0);
  }

  // Closing balance
  const closingBalance = openingBalance + outstandingBalance;

  // Product-wise ledger
  const productLedger = {};
  allOrders.forEach(order => {
    let items = [];
    
    if (order.items && Array.isArray(order.items) && order.items.length > 0) {
      // Sell order with items array
      items = order.items;
    } else {
      // Agri sales order - single item
      items = [{
        product: order.productId,
        productId: order.productId?._id || order.productId,
        productName: order.productName || order.productId?.name || 'Unknown',
        isRamAgriProduct: order.isRamAgriProduct || false,
        ramAgriCropId: order.ramAgriCropId?._id || order.ramAgriCropId,
        ramAgriCropName: order.ramAgriCropName || order.ramAgriCropId?.cropName,
        ramAgriVarietyId: order.ramAgriVarietyId,
        ramAgriVarietyName: order.ramAgriVarietyName,
        quantity: order.quantity || 0,
        rate: order.rate || 0,
        amount: order.totalAmount || 0,
      }];
    }

    items.forEach(item => {
      let productId, productName;

      if (item.isRamAgriProduct) {
        const cropId = item.ramAgriCropId?._id?.toString() || item.ramAgriCropId?.toString() || '';
        const varietyId = item.ramAgriVarietyId?.toString() || '';
        productId = `ram_${cropId}_${varietyId}`;
        productName = `${item.ramAgriCropName || 'Unknown'} - ${item.ramAgriVarietyName || 'Unknown'}`;
      } else {
        productId = item.product?._id?.toString() || item.product?.toString() || item.productId?.toString() || 'unknown';
        productName = item.productName || item.product?.name || 'Unknown';
      }

      if (!productId || productId === 'unknown') return; // Skip invalid products

      if (!productLedger[productId]) {
        productLedger[productId] = {
          productId,
          productName,
          totalQuantity: 0,
          totalValue: 0,
          totalPaid: 0,
          orders: [],
        };
      }

      const itemQuantity = item.quantity || 0;
      const itemAmount = item.amount || (item.rate ? item.rate * itemQuantity : itemQuantity) || 0;

      productLedger[productId].totalQuantity += itemQuantity;
      productLedger[productId].totalValue += itemAmount;
      productLedger[productId].orders.push({
        orderNumber: order.orderNumber || order._id.toString(),
        date: order.orderDate || order.createdAt,
        quantity: itemQuantity,
        amount: itemAmount,
        customerName: order.customerName || order.buyerName || 'Unknown',
      });
    });
  });

  // Customer-wise ledger
  const customerLedger = {};
  allOrders.forEach(order => {
    const customerName = order.customerName || order.buyerName || 'Unknown';
    const customerMobile = order.customerMobile || order.buyerMobile || '';
    const key = `${customerName}_${customerMobile}`;

    if (!customerLedger[key]) {
      customerLedger[key] = {
        customerName,
        customerMobile,
        totalOrders: 0,
        totalOrderValue: 0,
        totalPaid: 0,
        outstanding: 0,
        orders: [],
      };
    }

    const paid = (order.payment || [])
      .filter(p => p.paymentStatus === 'COLLECTED')
      .reduce((sum, p) => sum + (p.paidAmount || 0), 0);

    // Get order total
    let orderTotal = order.totalAmount || 0;
    if (!orderTotal && order.items && Array.isArray(order.items)) {
      orderTotal = order.items.reduce((itemSum, item) => itemSum + (item.amount || 0), 0);
    }
    
    customerLedger[key].totalOrders += 1;
    customerLedger[key].totalOrderValue += orderTotal;
    customerLedger[key].totalPaid += paid;
    customerLedger[key].outstanding += (orderTotal - paid);
    customerLedger[key].orders.push({
      orderNumber: order.orderNumber || order._id.toString(),
      date: order.orderDate || order.createdAt,
      amount: orderTotal,
      paid,
      outstanding: (orderTotal - paid),
    });
  });

  // Payment status breakdown
  const paymentStatusBreakdown = {
    collected: allPayments.filter(p => p.paymentStatus === 'COLLECTED').length,
    pending: allPayments.filter(p => p.paymentStatus === 'PENDING').length,
    rejected: allPayments.filter(p => p.paymentStatus === 'REJECTED').length,
  };

  // Daily sales trend
  const dailySales = {};
  allOrders.forEach(order => {
    const date = new Date(order.orderDate || order.createdAt).toISOString().split('T')[0];
    if (!dailySales[date]) {
      dailySales[date] = { date, sales: 0, orders: 0 };
    }
    
    // Get order total
    let orderTotal = order.totalAmount || 0;
    if (!orderTotal && order.items && Array.isArray(order.items)) {
      orderTotal = order.items.reduce((itemSum, item) => itemSum + (item.amount || 0), 0);
    }
    
    dailySales[date].sales += orderTotal;
    dailySales[date].orders += 1;
  });

  // Prepare response
  const responseData = {
    stock: {
      summary: {
        totalProducts,
        totalCrops,
        totalVarieties,
        totalStockValue,
        totalCurrentStock,
        lowStockCount: lowStockProducts.length,
        outOfStockCount,
      },
      lowStockProducts: lowStockProducts.slice(0, 50).map(p => ({
        _id: p._id,
        name: p.name,
        category: p.category,
        currentStock: p.currentStock || 0,
        minStockLevel: p.minStockLevel || 0,
      })),
      outOfStockProducts: outOfStockProducts.slice(0, 50).map(p => ({
        _id: p._id,
        name: p.name,
        category: p.category,
      })),
      stockByCategory: Object.values(stockByCategory),
      topCrops: crops.slice(0, 10).map(crop => ({
        _id: crop._id,
        cropName: crop.cropName,
        varietiesCount: crop.varieties?.length || 0,
        totalStock: crop.varieties?.reduce((sum, v) => sum + (v.currentStock || 0), 0) || 0,
        totalValue: crop.varieties?.reduce((sum, v) => sum + (v.stockValue || 0), 0) || 0,
      })),
    },
    ledger: {
      summary: {
        totalOrders,
        totalOrderValue,
        totalPaidAmount,
        totalPendingAmount,
        outstandingBalance,
        openingBalance,
        closingBalance,
      },
      payments: allPayments
        .sort((a, b) => new Date(b.paymentDate || b.orderDate) - new Date(a.paymentDate || a.orderDate))
        .slice(0, 100)
        .map(p => ({
          orderNumber: p.orderNumber,
          paymentDate: p.paymentDate || p.orderDate,
          customerName: p.customerName,
          customerMobile: p.customerMobile,
          paidAmount: p.paidAmount || 0,
          paymentStatus: p.paymentStatus,
          modeOfPayment: p.modeOfPayment || '',
        })),
      productLedger: Object.values(productLedger)
        .sort((a, b) => b.totalValue - a.totalValue)
        .slice(0, 100),
      customerLedger: Object.values(customerLedger)
        .sort((a, b) => b.outstanding - a.outstanding)
        .slice(0, 100),
      paymentStatusBreakdown,
      dailySales: Object.values(dailySales)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-30), // Last 30 days
    },
  };

  const response = generateResponse(
    "Success",
    "CEO Dashboard data fetched successfully",
    responseData,
    undefined
  );

  return res.status(200).json(response);
});

