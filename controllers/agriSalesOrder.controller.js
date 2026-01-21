import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import APIFeatures from "../utility/apiFeatures.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import { InventoryProduct, InventoryOutwardTransaction, StockAdjustment } from "../models/inventory.model.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";
import Farmer from "../models/farmer.model.js";
import Vehicle from "../models/vehicleModel.model.js";
import User from "../models/user.model.js";
import mongoose from "mongoose";

// ==================== CREATE AGRI SALES ORDER ====================

const createAgriSalesOrder = catchAsync(async (req, res, next) => {
  const {
    customerName,
    customerMobile,
    customerVillage,
    customerTaluka,
    customerDistrict,
    customerState,
    // Regular product fields
    productId,
    // Ram Agri product fields
    isRamAgriProduct,
    ramAgriCropId,
    ramAgriVarietyId,
    ramAgriCropName,
    ramAgriVarietyName,
    primaryUnit,
    secondaryUnit,
    conversionFactor,
    quantity,
    rate,
    orderDate,
    deliveryDate,
    notes,
    payment,
    screenshots,
  } = req.body;

  // Validate required fields
  if (!customerName || !customerMobile || !quantity || !rate) {
    return next(new AppError("Customer name, mobile, quantity, and rate are required", 400));
  }

  // Validate mobile number (10 digits)
  if (customerMobile.length !== 10 || !/^\d{10}$/.test(customerMobile)) {
    return next(new AppError("Mobile number must be exactly 10 digits", 400));
  }

  let product = null;
  let variety = null;
  let crop = null;
  let productName = "";
  let unit = "";
  let currentStock = 0;

  // Handle Ram Agri products
  if (isRamAgriProduct) {
    if (!ramAgriCropId || !ramAgriVarietyId) {
      return next(new AppError("Crop ID and Variety ID are required for Ram Agri products", 400));
    }

    if (!mongoose.isValidObjectId(ramAgriCropId) || !mongoose.isValidObjectId(ramAgriVarietyId)) {
      return next(new AppError("Invalid Crop ID or Variety ID format", 400));
    }

    // Get crop and variety
    crop = await RamAgriInputsProduct.findById(ramAgriCropId)
      .populate("varieties.primaryUnit", "name abbreviation")
      .populate("varieties.secondaryUnit", "name abbreviation");
    
    if (!crop) {
      return next(new AppError("Crop not found", 404));
    }

    variety = crop.varieties.id(ramAgriVarietyId);
    if (!variety) {
      return next(new AppError("Variety not found", 404));
    }

    if (!variety.isActive) {
      return next(new AppError("This variety is not active", 400));
    }

    // NOTE: Stock check removed - stock is only checked/deducted at dispatch time
    currentStock = variety.currentStock || 0;

    // Set product name and unit
    productName = `${crop.cropName} - ${variety.name}`;
    unit = variety.primaryUnit?.abbreviation || variety.primaryUnit?.name || "N/A";
  } else {
    // Handle regular products
    if (!productId) {
      return next(new AppError("Product ID is required for regular products", 400));
    }

    if (!mongoose.isValidObjectId(productId)) {
      return next(new AppError("Invalid product ID format", 400));
    }

    product = await InventoryProduct.findById(productId);
    if (!product) {
      return next(new AppError("Product not found", 404));
    }

    if (!product.isAgriSales) {
      return next(new AppError("This product is not available for Agri Sales orders", 400));
    }

    // NOTE: Stock check removed - stock is only checked/deducted at dispatch time
    currentStock = product.currentStock || 0;

    productName = product.name;
    unit = product.unit || "N/A";
  }

  // Calculate total amount
  const totalAmount = quantity * rate;

  // Process payment array - ensure paymentStatus is set for each payment
  let processedPayments = [];
  let initialPaidAmount = 0;
  
  if (payment && Array.isArray(payment) && payment.length > 0) {
    processedPayments = payment.map((p) => ({
      paidAmount: p.paidAmount || 0,
      paymentStatus: p.paymentStatus || "PENDING",
      paymentDate: p.paymentDate ? new Date(p.paymentDate) : new Date(),
      bankName: p.bankName || "",
      transactionId: p.transactionId || "",
      receiptPhoto: p.receiptPhoto || [],
      modeOfPayment: p.modeOfPayment || (p.isWalletPayment ? "Wallet" : ""),
      remark: p.remark || "",
      isWalletPayment: p.isWalletPayment || false,
    }));
    
    // Calculate total paid amount (only from COLLECTED payments)
    initialPaidAmount = processedPayments
      .filter((p) => p.paymentStatus === "COLLECTED")
      .reduce((sum, p) => sum + (p.paidAmount || 0), 0);
  }

  // Calculate initial payment status
  let initialPaymentStatus = "PENDING";
  if (processedPayments.length > 0) {
    const totalPending = processedPayments.reduce((sum, p) => sum + (p.paidAmount || 0), 0);
    if (initialPaidAmount >= totalAmount) {
      initialPaymentStatus = "COMPLETED";
    } else if (initialPaidAmount > 0) {
      initialPaymentStatus = "PARTIAL";
    } else {
      initialPaymentStatus = "PENDING";
    }
  }

  // Get user ID from request (employee who created the order)
  const userId = req.user?._id || req.user?.id;
  if (!userId) {
    return next(new AppError("User authentication required. Please login to create orders.", 401));
  }

  // Create order with proper user tracking
  const orderData = {
    customerName: customerName.trim(),
    customerMobile: customerMobile.trim(),
    customerVillage: customerVillage?.trim() || "",
    customerTaluka: customerTaluka?.trim() || "",
    customerDistrict: customerDistrict?.trim() || "",
    customerState: (customerState || "Maharashtra").trim(),
    isRamAgriProduct: isRamAgriProduct || false,
    productName,
    quantity,
    rate,
    totalAmount,
    orderDate: orderDate ? new Date(orderDate) : new Date(),
    deliveryDate: deliveryDate && deliveryDate !== 'null' && deliveryDate !== null ? new Date(deliveryDate) : undefined,
    notes: notes?.trim() || "",
    payment: processedPayments,
    screenshots: screenshots || [],
    createdBy: userId, // Track which employee created this order
    orderStatus: "PENDING",
    paymentStatus: initialPaymentStatus,
    totalPaidAmount: initialPaidAmount,
    balanceAmount: totalAmount - initialPaidAmount,
  };

  // Add product-specific fields
  if (isRamAgriProduct) {
    orderData.ramAgriCropId = ramAgriCropId;
    orderData.ramAgriVarietyId = ramAgriVarietyId;
    orderData.ramAgriCropName = ramAgriCropName || crop.cropName;
    orderData.ramAgriVarietyName = ramAgriVarietyName || variety.name;
    orderData.primaryUnit = variety.primaryUnit?._id || primaryUnit;
    // Convert empty string to null for secondaryUnit (MongoDB ObjectId fields don't accept empty strings)
    const secondaryUnitValue = variety.secondaryUnit?._id || secondaryUnit;
    orderData.secondaryUnit = secondaryUnitValue && secondaryUnitValue !== "" ? secondaryUnitValue : null;
    orderData.conversionFactor = variety.conversionFactor || conversionFactor || 1;
    // Explicitly set productId to null for Ram Agri products to avoid validation errors
    orderData.productId = null;
  } else {
    orderData.productId = productId;
    orderData.unit = unit;
    // Explicitly set Ram Agri fields to null/undefined for regular products
    orderData.ramAgriCropId = null;
    orderData.ramAgriVarietyId = null;
  }

  const order = await AgriSalesOrder.create(orderData);

  // Add activity log for order creation
  order.activityLog = [{
    action: "ORDER_CREATED",
    description: `Order created for ${customerName} - ${productName} (Qty: ${quantity}, Rate: ₹${rate})`,
    performedBy: userId,
    performedByName: req.user?.name || "Unknown",
    newValue: {
      customerName,
      customerMobile,
      productName,
      quantity,
      rate,
      totalAmount,
    },
    metadata: {
      orderNumber: order.orderNumber,
    },
  }];

  // Add payment activity if payment was added during creation
  if (processedPayments.length > 0) {
    processedPayments.forEach((p, index) => {
      order.activityLog.push({
        action: "PAYMENT_ADDED",
        description: `Payment of ₹${p.paidAmount} added via ${p.modeOfPayment}`,
        performedBy: userId,
        performedByName: req.user?.name || "Unknown",
        newValue: {
          paidAmount: p.paidAmount,
          modeOfPayment: p.modeOfPayment,
          paymentStatus: p.paymentStatus,
        },
      });
    });
  }

  await order.save();

  // Populate fields
  if (!isRamAgriProduct) {
    await order.populate("productId");
  } else {
    await order.populate("ramAgriCropId");
    await order.populate("primaryUnit");
    await order.populate("secondaryUnit");
  }
  await order.populate("createdBy");

  const response = generateResponse(
    "Success",
    "Agri Sales Order created successfully",
    order,
    undefined
  );

  return res.status(201).json(response);
});

// ==================== ACCEPT ORDER (NO STOCK CHECK - Stock checked/deducted only on direct admin dispatch) ====================

const acceptAgriSalesOrder = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  if (order.orderStatus !== "PENDING") {
    return next(new AppError(`Cannot accept order with status: ${order.orderStatus}`, 400));
  }

  // NO stock check on accept - stock will be checked only when admin dispatches directly
  // If order is assigned to sales person, no stock check/deduction happens at all

  // Update order status (NO stock deduction - happens on direct admin dispatch only)
  order.orderStatus = "ACCEPTED";
  order.stockDeducted = false; // Stock will be deducted only on direct admin dispatch
  order.acceptedBy = req.user?._id || req.user?.id;
  order.acceptedAt = new Date();

  // Add activity log
  if (!order.activityLog) order.activityLog = [];
  order.activityLog.push({
    action: "ORDER_ACCEPTED",
    description: `Order accepted. Status: PENDING → ACCEPTED. Stock will be checked/deducted only if admin dispatches directly.`,
    performedBy: req.user?._id || req.user?.id,
    performedByName: req.user?.name || "Unknown",
    previousValue: { orderStatus: "PENDING" },
    newValue: { orderStatus: "ACCEPTED" },
    metadata: { requiredQuantity: order.quantity },
  });

  await order.save();

  // Populate fields
  if (!order.isRamAgriProduct) {
    await order.populate("productId");
  } else {
    await order.populate("ramAgriCropId");
    await order.populate("primaryUnit");
    await order.populate("secondaryUnit");
  }
  await order.populate("createdBy");
  await order.populate("acceptedBy");

  const response = generateResponse(
    "Success",
    "Order accepted successfully. Stock will be deducted on dispatch.",
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== REJECT ORDER ====================

const rejectAgriSalesOrder = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  // Can reject PENDING orders, or cancel ACCEPTED/ASSIGNED orders
  if (!["PENDING", "ACCEPTED", "ASSIGNED"].includes(order.orderStatus)) {
    return next(new AppError(`Cannot reject order with status: ${order.orderStatus}`, 400));
  }

  // Store whether stock was deducted (before we update the order)
  const stockWasDeducted = order.stockDeducted && order.orderStatus === "ACCEPTED";

  // If order was ACCEPTED and stock was deducted, add stock back
  if (stockWasDeducted) {
    if (order.isRamAgriProduct) {
      // Handle Ram Agri variety stock restoration
      const crop = await RamAgriInputsProduct.findById(order.ramAgriCropId);
      if (!crop) {
        return next(new AppError("Crop not found", 404));
      }

      const variety = crop.varieties.id(order.ramAgriVarietyId);
      if (!variety) {
        return next(new AppError("Variety not found", 404));
      }

      // Restore variety stock
      variety.currentStock = (variety.currentStock || 0) + order.quantity;
      variety.stockValue = (variety.stockValue || 0) + (order.quantity * order.rate);
      if (variety.currentStock > 0) {
        variety.averagePrice = variety.stockValue / variety.currentStock;
      }
      await crop.save();
    } else {
      // Handle regular product stock restoration
      const product = await InventoryProduct.findById(order.productId);
      if (!product) {
        return next(new AppError("Product not found", 404));
      }

      // Add stock back using StockAdjustment (for ledger tracking)
      await StockAdjustment.create({
        productId: order.productId,
        adjustmentType: "addition",
        quantity: order.quantity,
        reason: "other",
        adjustedBy: req.user?._id || req.user?.id,
        notes: `Ram Agri Sales Order Rejected: ${order.orderNumber}. ${reason || "Order rejected"}`,
      });

      // Update product stock
      product.currentStock += order.quantity;
      await product.save();
    }
  }

  // Store previous status for activity log
  const previousStatus = order.orderStatus;

  // Update order status
  order.orderStatus = "REJECTED";
  order.stockDeducted = false;
  order.stockDeductedAt = null;
  if (reason) {
    if (!order.remarks) order.remarks = [];
    order.remarks.push(`Rejected: ${reason}`);
  }

  // Add activity log
  if (!order.activityLog) order.activityLog = [];
  order.activityLog.push({
    action: "ORDER_REJECTED",
    description: `Order rejected${reason ? `: ${reason}` : ""}${stockWasDeducted ? " (stock restored)" : ""}`,
    performedBy: req.user?._id || req.user?.id,
    performedByName: req.user?.name || "Unknown",
    previousValue: { orderStatus: previousStatus, stockDeducted: stockWasDeducted },
    newValue: { orderStatus: "REJECTED", stockDeducted: false },
    metadata: { reason, stockRestored: stockWasDeducted },
  });

  await order.save();

  // Populate fields
  if (!order.isRamAgriProduct) {
    await order.populate("productId");
  } else {
    await order.populate("ramAgriCropId");
    await order.populate("primaryUnit");
    await order.populate("secondaryUnit");
  }
  await order.populate("createdBy");

  const response = generateResponse(
    "Success",
    stockWasDeducted ? "Order rejected and stock restored successfully" : "Order rejected successfully",
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== CANCEL ORDER ====================

const cancelAgriSalesOrder = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  // Can only cancel ACCEPTED orders
  if (order.orderStatus !== "ACCEPTED") {
    return next(new AppError(`Cannot cancel order with status: ${order.orderStatus}. Only ACCEPTED orders can be cancelled.`, 400));
  }

  // Store whether stock was deducted (before we update the order)
  const stockWasDeducted = order.stockDeducted;

  // If stock was deducted, add stock back
  if (stockWasDeducted) {
    // Get product
    const product = await InventoryProduct.findById(order.productId);
    if (!product) {
      return next(new AppError("Product not found", 404));
    }

    // Add stock back using StockAdjustment (for ledger tracking)
    await StockAdjustment.create({
      productId: order.productId,
      adjustmentType: "addition",
      quantity: order.quantity,
      reason: "other",
      adjustedBy: req.user?._id || req.user?.id,
      notes: `Ram Agri Sales Order Cancelled: ${order.orderNumber}. ${reason || "Order cancelled"}`,
    });

    // Update product stock
    product.currentStock += order.quantity;
    await product.save();
  }

  // Update order status
  order.orderStatus = "CANCELLED";
  order.stockDeducted = false;
  order.stockDeductedAt = null;
  if (reason) {
    if (!order.remarks) order.remarks = [];
    order.remarks.push(`Cancelled: ${reason}`);
  }
  await order.save();

  // Populate fields
  await order.populate("productId");
  await order.populate("createdBy");
  await order.populate("acceptedBy");

  const response = generateResponse(
    "Success",
    stockWasDeducted ? "Order cancelled and stock restored successfully" : "Order cancelled successfully",
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET ALL AGRI SALES ORDERS ====================

const getAllAgriSalesOrders = catchAsync(async (req, res, next) => {
  const {
    sortKey = "createdAt",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 10,
    orderStatus,
    dispatchStatus, // Filter by dispatch status (DISPATCHED, IN_TRANSIT, DELIVERED, etc.)
    paymentStatus,
    productId,
    customerMobile,
    createdBy, // Filter by employee who created the order
    startDate,
    endDate,
    myOrders, // Boolean: if true, show only orders created by current user
    customerVillage, // Filter by village
    customerTaluka, // Filter by taluka
    customerDistrict, // Filter by district
  } = req.query;

  let query = AgriSalesOrder.find();

  // User-wise filtering: Show only orders created by current user if myOrders=true
  if (myOrders === "true" || myOrders === true) {
    const userId = req.user?._id || req.user?.id;
    if (userId) {
      query = query.where("createdBy").equals(userId);
    }
  }

  // Filter by specific createdBy (employee ID) - for admin/manager view
  if (createdBy && mongoose.isValidObjectId(createdBy)) {
    query = query.where("createdBy").equals(createdBy);
  }

  // Search by customer name, mobile, or order number
  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { customerName: searchRegex },
      { customerMobile: searchRegex },
      { orderNumber: searchRegex },
      { productName: searchRegex },
    ]);
  }

  // Filter by order status
  if (orderStatus) {
    query = query.where("orderStatus").equals(orderStatus);
  }

  // Filter by dispatch status
  if (dispatchStatus) {
    query = query.where("dispatchStatus").equals(dispatchStatus);
  }

  // Filter by payment status
  if (paymentStatus) {
    query = query.where("paymentStatus").equals(paymentStatus);
  }

  // Filter by product
  if (productId && mongoose.isValidObjectId(productId)) {
    query = query.where("productId").equals(productId);
  }

  // Filter by customer mobile
  if (customerMobile) {
    query = query.where("customerMobile").equals(customerMobile);
  }

  // Filter by location (village, taluka, district)
  if (customerVillage) {
    query = query.where("customerVillage").equals(customerVillage);
  }
  if (customerTaluka) {
    query = query.where("customerTaluka").equals(customerTaluka);
  }
  if (customerDistrict) {
    query = query.where("customerDistrict").equals(customerDistrict);
  }

  // Filter by date range
  if (startDate || endDate) {
    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query = query.where("orderDate").gte(start).lte(end);
    } else if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      query = query.where("orderDate").gte(start);
    } else if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query = query.where("orderDate").lte(end);
    }
  }

  // Sort
  const sort = {};
  sort[sortKey] = sortOrder === "desc" ? -1 : 1;
  query = query.sort(sort);

  // Pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  // Populate references
  query = query
    .populate("productId")
    .populate("createdBy")
    .populate("acceptedBy")
    .populate("dispatchedBy")
    .populate("vehicleId")
    .populate("assignedTo", "name phoneNumber jobTitle")
    .populate("assignedBy", "name phoneNumber");

  const [orders, total] = await Promise.all([
    query.exec(),
    AgriSalesOrder.countDocuments(query.getFilter()),
  ]);

  const response = generateResponse(
    "Success",
    "Agri Sales Orders fetched successfully",
    {
      data: orders,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET ORDER BY ID ====================

const getAgriSalesOrderById = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  const order = await AgriSalesOrder.findById(id)
    .populate("productId")
    .populate("createdBy")
    .populate("acceptedBy")
    .populate("dispatchedBy")
    .populate("vehicleId");

  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  const response = generateResponse(
    "Success",
    "Agri Sales Order fetched successfully",
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== ADD PAYMENT TO ORDER ====================

const addPaymentToAgriSalesOrder = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const {
    paidAmount,
    paymentDate,
    modeOfPayment,
    bankName,
    transactionId,
    receiptPhoto,
    remark,
    isWalletPayment,
  } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  if (!paidAmount || paidAmount <= 0) {
    return next(new AppError("Paid amount is required and must be greater than 0", 400));
  }

  if (!isWalletPayment && !modeOfPayment) {
    return next(new AppError("Payment mode is required for non-wallet payments", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  // Store previous values for activity log
  const previousTotalPaid = order.totalPaidAmount || 0;
  const previousBalance = order.balanceAmount || order.totalAmount;
  const previousPaymentStatus = order.paymentStatus;

  // Add payment
  const newPayment = {
    paidAmount,
    paymentDate: paymentDate || new Date(),
    modeOfPayment: isWalletPayment ? "Wallet" : modeOfPayment,
    bankName: bankName || "",
    transactionId: transactionId || "",
    receiptPhoto: receiptPhoto || [],
    remark: remark || "",
    isWalletPayment: isWalletPayment || false,
    paymentStatus: "PENDING",
  };

  if (!order.payment) order.payment = [];
  order.payment.push(newPayment);

  // Update payment totals
  order.totalPaidAmount = order.payment.reduce((sum, p) => sum + (p.paidAmount || 0), 0);
  order.balanceAmount = order.totalAmount - order.totalPaidAmount;

  // Update payment status
  if (order.balanceAmount <= 0) {
    order.paymentStatus = "COMPLETED";
  } else if (order.totalPaidAmount > 0) {
    order.paymentStatus = "PARTIAL";
  } else {
    order.paymentStatus = "PENDING";
  }

  // Add activity log
  if (!order.activityLog) order.activityLog = [];
  order.activityLog.push({
    action: "PAYMENT_ADDED",
    description: `Payment of ₹${paidAmount} added via ${isWalletPayment ? "Wallet" : modeOfPayment}`,
    performedBy: req.user?._id || req.user?.id,
    performedByName: req.user?.name || "Unknown",
    previousValue: {
      totalPaidAmount: previousTotalPaid,
      balanceAmount: previousBalance,
      paymentStatus: previousPaymentStatus,
    },
    newValue: {
      paidAmount,
      modeOfPayment: isWalletPayment ? "Wallet" : modeOfPayment,
      totalPaidAmount: order.totalPaidAmount,
      balanceAmount: order.balanceAmount,
      paymentStatus: order.paymentStatus,
    },
    metadata: {
      bankName,
      transactionId,
      remark,
      paymentIndex: order.payment.length - 1,
    },
  });

  await order.save();

  // Populate fields
  await order.populate("productId");
  await order.populate("createdBy");
  await order.populate("acceptedBy");

  const response = generateResponse(
    "Success",
    "Payment added successfully",
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== UPDATE PAYMENT STATUS ====================

const updatePaymentStatus = catchAsync(async (req, res, next) => {
  const { id, paymentIndex } = req.params;
  const { paymentStatus } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  if (!["COLLECTED", "REJECTED", "PENDING"].includes(paymentStatus)) {
    return next(new AppError("Invalid payment status", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  const index = parseInt(paymentIndex);
  if (!order.payment || index < 0 || index >= order.payment.length) {
    return next(new AppError("Invalid payment index", 400));
  }

  // Store previous status for activity log
  const previousPaymentStatus = order.payment[index].paymentStatus;
  const paymentAmount = order.payment[index].paidAmount;

  // Update payment status
  order.payment[index].paymentStatus = paymentStatus;

  // Add activity log
  if (!order.activityLog) order.activityLog = [];
  order.activityLog.push({
    action: "PAYMENT_STATUS_CHANGED",
    description: `Payment #${index + 1} (₹${paymentAmount}) status changed from ${previousPaymentStatus} to ${paymentStatus}`,
    performedBy: req.user?._id || req.user?.id,
    performedByName: req.user?.name || "Unknown",
    previousValue: { paymentStatus: previousPaymentStatus },
    newValue: { paymentStatus },
    metadata: {
      paymentIndex: index,
      paymentAmount,
    },
  });

  await order.save();

  // Populate fields
  await order.populate("productId");
  await order.populate("createdBy");
  await order.populate("acceptedBy");

  const response = generateResponse(
    "Success",
    "Payment status updated successfully",
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET FARMER BY MOBILE (for auto-fill) ====================

const getCustomerByMobile = catchAsync(async (req, res, next) => {
  const { mobileNumber } = req.params;

  if (!mobileNumber || mobileNumber.length !== 10 || !/^\d{10}$/.test(mobileNumber)) {
    return next(new AppError("Valid 10-digit mobile number is required", 400));
  }

  // Try to find farmer first
  const farmer = await Farmer.findOne({ mobileNumber });

  if (farmer) {
    return res.status(200).json({
      status: "Success",
      message: "Customer found (Farmer)",
      data: {
        name: farmer.name,
        mobileNumber: farmer.mobileNumber,
        village: farmer.village || farmer.villageName || "",
        taluka: farmer.taluka || farmer.talukaName || "",
        district: farmer.district || farmer.districtName || "",
        state: farmer.state || farmer.stateName || "Maharashtra",
        type: "farmer",
      },
    });
  }

  // If no farmer found, return empty structure
  return res.status(404).json({
    status: "fail",
    message: "No customer found for the given mobile number",
  });
});

// ==================== UPDATE AGRI SALES ORDER ====================

const updateAgriSalesOrder = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const updateData = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  // Don't allow updates if order is completed or cancelled
  if (order.orderStatus === "COMPLETED" || order.orderStatus === "CANCELLED") {
    return next(new AppError("Cannot update completed or cancelled order", 400));
  }

  // Fields that can be updated
  const allowedFields = [
    "customerName",
    "customerMobile",
    "customerVillage",
    "customerTaluka",
    "customerDistrict",
    "customerState",
    "productId",
    "quantity",
    "unit",
    "rate",
    "orderDate",
    "deliveryDate",
    "notes",
    "screenshots",
  ];

  // Filter and validate update data
  const filteredData = {};
  Object.keys(updateData).forEach((key) => {
    if (allowedFields.includes(key)) {
      filteredData[key] = updateData[key];
    }
  });

  // Check if there are any fields to update
  if (Object.keys(filteredData).length === 0) {
    return next(new AppError("No valid fields provided for update. Allowed fields: " + allowedFields.join(", "), 400));
  }

  // Validate mobile number if being updated
  if (filteredData.customerMobile) {
    const mobile = filteredData.customerMobile.toString();
    if (mobile.length !== 10 || !/^\d{10}$/.test(mobile)) {
      return next(new AppError("Mobile number must be exactly 10 digits", 400));
    }
    filteredData.customerMobile = mobile;
  }

  // If productId is being updated, validate it and update productName
  if (filteredData.productId) {
    if (!mongoose.isValidObjectId(filteredData.productId)) {
      return next(new AppError("Invalid product ID format", 400));
    }

    const product = await InventoryProduct.findById(filteredData.productId);
    if (!product) {
      return next(new AppError("Product not found", 404));
    }

    if (!product.isAgriSales) {
      return next(new AppError("Product is not available for Agri Sales", 400));
    }

    filteredData.productName = product.name;
    
    // If unit is not provided, use product's primary unit
    if (!filteredData.unit && product.primaryUnit) {
      filteredData.unit = product.primaryUnit.abbreviation || product.primaryUnit.name.toLowerCase();
    }
  }

  // Store previous values for activity log
  const previousValues = {};
  Object.keys(filteredData).forEach((key) => {
    previousValues[key] = order[key];
  });

  // Update order fields
  Object.keys(filteredData).forEach((key) => {
    order[key] = filteredData[key];
  });

  // Determine action type based on what was updated
  let actionType = "ORDER_UPDATED";
  let description = "Order details updated";
  
  if (filteredData.customerName || filteredData.customerMobile || filteredData.customerVillage || 
      filteredData.customerTaluka || filteredData.customerDistrict) {
    actionType = "CUSTOMER_UPDATED";
    description = "Customer details updated";
  } else if (filteredData.productId) {
    actionType = "PRODUCT_UPDATED";
    description = `Product changed to ${filteredData.productName || "new product"}`;
  } else if (filteredData.quantity !== undefined) {
    actionType = "QUANTITY_UPDATED";
    description = `Quantity changed from ${previousValues.quantity} to ${filteredData.quantity}`;
  } else if (filteredData.rate !== undefined) {
    actionType = "RATE_UPDATED";
    description = `Rate changed from ₹${previousValues.rate} to ₹${filteredData.rate}`;
  } else if (filteredData.notes !== undefined) {
    actionType = "NOTES_UPDATED";
    description = "Order notes updated";
  } else if (filteredData.deliveryDate !== undefined) {
    actionType = "DELIVERY_DATE_UPDATED";
    description = "Delivery date updated";
  }

  // Add activity log
  if (!order.activityLog) order.activityLog = [];
  order.activityLog.push({
    action: actionType,
    description,
    performedBy: req.user?._id || req.user?.id,
    performedByName: req.user?.name || "Unknown",
    previousValue: previousValues,
    newValue: filteredData,
    metadata: { fieldsUpdated: Object.keys(filteredData) },
  });

  // Save order (this will trigger pre-save hook to recalculate totalAmount and balanceAmount)
  await order.save();

  // Populate references
  await order.populate("productId");
  await order.populate("createdBy");
  await order.populate("acceptedBy");

  const response = generateResponse(
    "Success",
    "Order updated successfully",
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET PENDING PAYMENTS FOR AGRI SALES ORDERS ====================
// Similar to sell orders pending payments - for accountant to accept/reject payments

const getPendingPayments = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 1000,
    search,
    startDate,
    endDate,
    paymentStatus = "PENDING",
  } = req.query;

  const query = {};

  // Search filtering (on order fields, not payment)
  if (search) {
    query.$or = [
      { orderNumber: { $regex: search, $options: "i" } },
      { customerName: { $regex: search, $options: "i" } },
      { customerMobile: { $regex: search, $options: "i" } },
      { productName: { $regex: search, $options: "i" } },
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  // Build date filter if dates are provided
  const dateFilter = {};
  if (startDate && startDate.trim()) {
    try {
      const [day, month, year] = startDate.split("-");
      if (day && month && year) {
        const start = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
        if (!isNaN(start.getTime())) {
          dateFilter.$gte = start;
        }
      }
    } catch (error) {
      console.error("Error parsing startDate:", error);
    }
  }
  if (endDate && endDate.trim()) {
    try {
      const [day, month, year] = endDate.split("-");
      if (day && month && year) {
        const end = new Date(`${year}-${month}-${day}T23:59:59.999Z`);
        if (!isNaN(end.getTime())) {
          dateFilter.$lte = end;
        }
      }
    } catch (error) {
      console.error("Error parsing endDate:", error);
    }
  }

  // Use aggregation to unwind payments and filter
  const pipeline = [
    { $match: query },
    { $unwind: { path: "$payment", includeArrayIndex: "paymentIndex", preserveNullAndEmptyArrays: false } },
    {
      $match: {
        ...(paymentStatus ? { "payment.paymentStatus": paymentStatus } : {}),
        ...(Object.keys(dateFilter).length > 0 ? { "payment.paymentDate": dateFilter } : {}),
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "createdBy",
        foreignField: "_id",
        as: "createdByData",
      },
    },
    {
      $lookup: {
        from: "inventoryproducts",
        localField: "productId",
        foreignField: "_id",
        as: "productData",
      },
    },
    {
      $project: {
        _id: 1,
        orderNumber: 1,
        customerName: 1,
        customerMobile: 1,
        customerVillage: 1,
        customerTaluka: 1,
        customerDistrict: 1,
        customerState: 1,
        productId: { $arrayElemAt: ["$productData", 0] },
        productName: 1,
        quantity: 1,
        unit: 1,
        rate: 1,
        totalAmount: 1,
        orderStatus: 1,
        paymentStatus: 1,
        totalPaidAmount: 1,
        balanceAmount: 1,
        orderDate: 1,
        deliveryDate: 1,
        payment: 1,
        paymentIndex: 1, // Include payment index for status updates
        screenshots: 1, // Include screenshots for image viewing
        createdBy: { $arrayElemAt: ["$createdByData", 0] },
        acceptedBy: 1,
        createdAt: 1,
      },
    },
    { $sort: { "createdAt": -1 } },
    { $skip: skip },
    { $limit: parseInt(limit) },
  ];

  const [payments, totalCountResult] = await Promise.all([
    AgriSalesOrder.aggregate(pipeline),
    AgriSalesOrder.aggregate([
      { $match: query },
      { $unwind: "$payment" },
      {
        $match: paymentStatus ? { "payment.paymentStatus": paymentStatus } : {},
      },
      { $count: "total" },
    ]),
  ]);

  const total = totalCountResult[0]?.total || 0;

  const response = generateResponse(
    "Success",
    "Pending payments fetched successfully",
    {
      data: payments,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET PENDING PAYMENTS COUNT ====================
// Get count of pending payments for Ram Agri Sales orders

const getPendingPaymentsCount = catchAsync(async (req, res, next) => {
  try {
    const count = await AgriSalesOrder.aggregate([
      { $unwind: { path: "$payment", preserveNullAndEmptyArrays: false } },
      { $match: { "payment.paymentStatus": "PENDING" } },
      { $count: "total" },
    ]);

    const totalCount = count[0]?.total || 0;

    const response = generateResponse(
      "Success",
      "Pending payments count fetched successfully",
      { count: totalCount },
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    return next(new AppError(`Failed to fetch pending payments count: ${error.message}`, 500));
  }
});

// ==================== GET OUTSTANDING ANALYSIS ====================
// Get outstanding amounts grouped by salesmen, district, taluka, villages

const getOutstandingAnalysis = catchAsync(async (req, res, next) => {
  const { startDate, endDate, createdBy } = req.query;

  try {
    // Build match query
    const matchQuery = {
      balanceAmount: { $gt: 0 }, // Only orders with outstanding balance
    };

    // If logged-in user has jobTitle RAM_AGRI_SALES, filter by their user ID
    // Otherwise, use the createdBy query parameter if provided
    if (req.user && req.user.jobTitle === "RAM_AGRI_SALES") {
      matchQuery.createdBy = req.user._id;
    } else if (createdBy && mongoose.isValidObjectId(createdBy)) {
      matchQuery.createdBy = new mongoose.Types.ObjectId(createdBy);
    }

    if (startDate || endDate) {
      matchQuery.orderDate = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        matchQuery.orderDate.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        matchQuery.orderDate.$lte = end;
      }
    }

    // Total outstanding
    const totalOutstanding = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: null,
          totalOutstanding: { $sum: "$balanceAmount" },
          totalOrders: { $sum: 1 },
        },
      },
    ]);

    // By Salesmen (createdBy)
    const bySalesmen = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $lookup: {
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          as: "salesmanData",
        },
      },
      { $unwind: { path: "$salesmanData", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$createdBy",
          salesmanName: { $first: "$salesmanData.name" },
          salesmanPhone: { $first: "$salesmanData.phoneNumber" },
          totalOutstanding: { $sum: "$balanceAmount" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { totalOutstanding: -1 } },
    ]);

    // By District
    const byDistrict = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: "$customerDistrict",
          totalOutstanding: { $sum: "$balanceAmount" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { totalOutstanding: -1 } },
    ]);

    // By Taluka
    const byTaluka = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            district: "$customerDistrict",
            taluka: "$customerTaluka",
          },
          totalOutstanding: { $sum: "$balanceAmount" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { totalOutstanding: -1 } },
    ]);

    // By Village
    const byVillage = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            district: "$customerDistrict",
            taluka: "$customerTaluka",
            village: "$customerVillage",
          },
          totalOutstanding: { $sum: "$balanceAmount" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { totalOutstanding: -1 } },
    ]);

    const response = generateResponse(
      "Success",
      "Outstanding analysis fetched successfully",
      {
        total: totalOutstanding[0] || { totalOutstanding: 0, totalOrders: 0 },
        bySalesmen,
        byDistrict,
        byTaluka,
        byVillage,
      },
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    return next(new AppError(`Failed to fetch outstanding analysis: ${error.message}`, 500));
  }
});

// ==================== GET SALES ANALYSIS ====================
// Get sales analysis grouped by salesmen, district, taluka, village

const getSalesAnalysis = catchAsync(async (req, res, next) => {
  const { startDate, endDate, createdBy } = req.query;

  try {
    // Build match query (all orders, not just outstanding)
    const matchQuery = {};

    if (createdBy && mongoose.isValidObjectId(createdBy)) {
      matchQuery.createdBy = new mongoose.Types.ObjectId(createdBy);
    }

    if (startDate || endDate) {
      matchQuery.orderDate = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        matchQuery.orderDate.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        matchQuery.orderDate.$lte = end;
      }
    }

    // Total sales
    const totalSales = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$totalAmount" },
          totalOrders: { $sum: 1 },
        },
      },
    ]);

    // By Salesmen (createdBy)
    const bySalesmen = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $lookup: {
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          as: "salesmanData",
        },
      },
      { $unwind: { path: "$salesmanData", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$createdBy",
          salesmanName: { $first: "$salesmanData.name" },
          salesmanPhone: { $first: "$salesmanData.phoneNumber" },
          totalAmount: { $sum: "$totalAmount" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { totalAmount: -1 } },
    ]);

    // By District (for each salesman)
    const byDistrict = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            createdBy: "$createdBy",
            district: "$customerDistrict",
          },
          totalAmount: { $sum: "$totalAmount" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { totalAmount: -1 } },
    ]);

    // By Taluka
    const byTaluka = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            createdBy: "$createdBy",
            district: "$customerDistrict",
            taluka: "$customerTaluka",
          },
          totalAmount: { $sum: "$totalAmount" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { totalAmount: -1 } },
    ]);

    // By Village
    const byVillage = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            createdBy: "$createdBy",
            district: "$customerDistrict",
            taluka: "$customerTaluka",
            village: "$customerVillage",
          },
          totalAmount: { $sum: "$totalAmount" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { totalAmount: -1 } },
    ]);

    const response = generateResponse(
      "Success",
      "Sales analysis fetched successfully",
      {
        total: totalSales[0] || { totalAmount: 0, totalOrders: 0 },
        bySalesmen,
        byDistrict,
        byTaluka,
        byVillage,
      },
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    return next(new AppError(`Failed to fetch sales analysis: ${error.message}`, 500));
  }
});

// ==================== GET CUSTOMER OUTSTANDING ====================
// Get outstanding amounts grouped by customer (farmer)

const getCustomerOutstanding = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;

  try {
    const matchQuery = {
      balanceAmount: { $gt: 0 },
    };

    if (startDate || endDate) {
      matchQuery.orderDate = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        matchQuery.orderDate.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        matchQuery.orderDate.$lte = end;
      }
    }

    const customerOutstanding = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            customerMobile: "$customerMobile",
            customerName: "$customerName",
          },
          customerVillage: { $first: "$customerVillage" },
          customerTaluka: { $first: "$customerTaluka" },
          customerDistrict: { $first: "$customerDistrict" },
          totalOutstanding: { $sum: "$balanceAmount" },
          totalOrders: { $sum: 1 },
          orders: {
            $push: {
              orderNumber: "$orderNumber",
              orderDate: "$orderDate",
              totalAmount: "$totalAmount",
              totalPaidAmount: "$totalPaidAmount",
              balanceAmount: "$balanceAmount",
              orderStatus: "$orderStatus",
            },
          },
        },
      },
      { $sort: { totalOutstanding: -1 } },
    ]);

    const response = generateResponse(
      "Success",
      "Customer outstanding fetched successfully",
      { data: customerOutstanding },
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    return next(new AppError(`Failed to fetch customer outstanding: ${error.message}`, 500));
  }
});

// ==================== ASSIGN ORDERS TO SALES PERSON ====================
// Admin assigns orders to a sales person for dispatch (no stock deduction)

const assignOrdersToSalesPerson = catchAsync(async (req, res, next) => {
  const {
    orderIds, // Array of order IDs to assign
    assignToUserId, // User ID of the sales person
    assignmentNotes, // Optional notes
  } = req.body;

  // Validate required fields
  if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
    return next(new AppError("At least one order ID is required", 400));
  }

  if (!assignToUserId) {
    return next(new AppError("Sales person ID is required", 400));
  }

  if (!mongoose.isValidObjectId(assignToUserId)) {
    return next(new AppError("Invalid sales person ID format", 400));
  }

  // Validate all order IDs
  for (const orderId of orderIds) {
    if (!mongoose.isValidObjectId(orderId)) {
      return next(new AppError(`Invalid order ID format: ${orderId}`, 400));
    }
  }

  // Verify the sales person exists and is a RAM_AGRI_SALES user
  const salesPerson = await User.findById(assignToUserId);
  if (!salesPerson) {
    return next(new AppError("Sales person not found", 404));
  }

  // Get user info for activity log
  const adminUserId = req.user?._id || req.user?.id;
  const adminUserName = req.user?.name || "Unknown";

  // Find orders that can be assigned (PENDING or ACCEPTED, not yet dispatched)
  const orders = await AgriSalesOrder.find({
    _id: { $in: orderIds },
    orderStatus: { $in: ["PENDING", "ACCEPTED"] },
    dispatchStatus: "NOT_DISPATCHED",
  });

  if (orders.length === 0) {
    return next(new AppError("No valid orders found for assignment. Orders must be PENDING or ACCEPTED and not yet dispatched.", 404));
  }

  const assignedAt = new Date();
  const updatedOrders = [];

  for (const order of orders) {
    const previousAssignedTo = order.assignedTo;

    const previousOrderStatus = order.orderStatus;
    
    // Update assignment fields
    order.assignedTo = assignToUserId;
    order.assignedAt = assignedAt;
    order.assignedBy = adminUserId;
    order.assignmentNotes = assignmentNotes || "";

    // Set order status to ASSIGNED
    order.orderStatus = "ASSIGNED";
    
    // If order was PENDING, also set accepted info
    if (previousOrderStatus === "PENDING") {
      order.acceptedBy = adminUserId;
      order.acceptedAt = assignedAt;
    }

    // Add activity log
    if (!order.activityLog) order.activityLog = [];
    order.activityLog.push({
      action: "ORDER_ASSIGNED",
      description: `Order assigned to ${salesPerson.name} (${salesPerson.phoneNumber}) for dispatch. Status: ${previousOrderStatus} → ASSIGNED`,
      performedBy: adminUserId,
      performedByName: adminUserName,
      previousValue: { 
        assignedTo: previousAssignedTo,
        orderStatus: previousOrderStatus,
      },
      newValue: { 
        assignedTo: assignToUserId,
        assignedToName: salesPerson.name,
        orderStatus: "ASSIGNED",
      },
      metadata: {
        assignmentNotes,
        assignedAt,
        salesPersonName: salesPerson.name,
        salesPersonPhone: salesPerson.phoneNumber,
      },
    });

    await order.save();
    updatedOrders.push(order);
  }

  // Populate fields for response
  await AgriSalesOrder.populate(updatedOrders, [
    { path: "productId" },
    { path: "createdBy" },
    { path: "assignedTo", select: "name phoneNumber jobTitle" },
    { path: "assignedBy", select: "name phoneNumber" },
  ]);

  const response = generateResponse(
    "Success",
    `${updatedOrders.length} order(s) assigned to ${salesPerson.name} successfully`,
    {
      orders: updatedOrders,
      assignedTo: {
        _id: salesPerson._id,
        name: salesPerson.name,
        phoneNumber: salesPerson.phoneNumber,
      },
      totalAssigned: updatedOrders.length,
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET ASSIGNED ORDERS FOR SALES PERSON ====================
// Get orders assigned to a specific sales person (for their dispatch view)

const getAssignedOrders = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 100,
    search,
    assignedTo, // Optional: filter by specific user (admin view)
  } = req.query;

  const userId = req.user?._id || req.user?.id;
  const userRole = req.user?.role;
  const userJobTitle = req.user?.jobTitle;

  // Build query
  let query = {
    orderStatus: "ASSIGNED", // Only show orders with ASSIGNED status
    dispatchStatus: "NOT_DISPATCHED", // Only show orders not yet dispatched
    assignedTo: { $exists: true, $ne: null }, // Must be assigned
  };

  // If user is a sales person, only show their assigned orders
  // If admin, can view all or filter by assignedTo
  if (userJobTitle === "RAM_AGRI_SALES" && userRole !== "SUPER_ADMIN") {
    query.assignedTo = userId;
  } else if (assignedTo && mongoose.isValidObjectId(assignedTo)) {
    query.assignedTo = assignedTo;
  }

  // Search filter
  if (search) {
    const searchRegex = new RegExp(search, "i");
    query.$or = [
      { customerName: searchRegex },
      { customerMobile: searchRegex },
      { orderNumber: searchRegex },
      { customerVillage: searchRegex },
    ];
  }

  // Execute query with pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  
  const [orders, total] = await Promise.all([
    AgriSalesOrder.find(query)
      .populate("productId")
      .populate("createdBy", "name phoneNumber")
      .populate("assignedTo", "name phoneNumber jobTitle")
      .populate("assignedBy", "name phoneNumber")
      .populate("ramAgriCropId")
      .populate("primaryUnit")
      .populate("secondaryUnit")
      .sort({ assignedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    AgriSalesOrder.countDocuments(query),
  ]);

  // Calculate payment summary for each order
  const ordersWithSummary = orders.map((order) => {
    const paymentSummary = {
      totalPaid: 0,
      totalPending: 0,
      totalRejected: 0,
      count: order.payment?.length || 0,
    };

    if (order.payment && Array.isArray(order.payment)) {
      order.payment.forEach((p) => {
        if (p.paymentStatus === "COLLECTED") {
          paymentSummary.totalPaid += p.paidAmount || 0;
        } else if (p.paymentStatus === "PENDING") {
          paymentSummary.totalPending += p.paidAmount || 0;
        } else if (p.paymentStatus === "REJECTED") {
          paymentSummary.totalRejected += p.paidAmount || 0;
        }
      });
    }

    return {
      ...order,
      paymentSummary,
    };
  });

  const response = generateResponse(
    "Success",
    "Assigned orders fetched successfully",
    {
      data: ordersWithSummary,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== CANCEL ASSIGNMENT ====================
// Admin or sales person can cancel assignment (return to unassigned state)

const cancelAssignment = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  if (!order.assignedTo) {
    return next(new AppError("Order is not assigned to anyone", 400));
  }

  // Get previous assignment info for activity log
  const previousAssignedTo = order.assignedTo;
  const previousAssignedToUser = await User.findById(previousAssignedTo);
  const previousOrderStatus = order.orderStatus;

  // Get user info for activity log
  const userId = req.user?._id || req.user?.id;
  const userName = req.user?.name || "Unknown";

  // Clear assignment and revert order status to ACCEPTED
  order.assignedTo = null;
  order.assignedAt = null;
  order.assignedBy = null;
  order.assignmentNotes = null;
  order.orderStatus = "ACCEPTED"; // Revert to ACCEPTED status

  // Add activity log
  if (!order.activityLog) order.activityLog = [];
  order.activityLog.push({
    action: "ASSIGNMENT_CANCELLED",
    description: `Assignment cancelled${previousAssignedToUser ? ` (was assigned to ${previousAssignedToUser.name})` : ""}${reason ? `: ${reason}` : ""}. Status: ${previousOrderStatus} → ACCEPTED`,
    performedBy: userId,
    performedByName: userName,
    previousValue: { 
      assignedTo: previousAssignedTo,
      assignedToName: previousAssignedToUser?.name,
      orderStatus: previousOrderStatus,
    },
    newValue: { 
      assignedTo: null,
      orderStatus: "ACCEPTED",
    },
    metadata: { reason },
  });

  await order.save();

  // Populate fields
  await order.populate("productId");
  await order.populate("createdBy");

  const response = generateResponse(
    "Success",
    "Assignment cancelled successfully",
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== DISPATCH ORDERS ====================
// Dispatch single or multiple orders with vehicle/driver or courier details

const dispatchOrders = catchAsync(async (req, res, next) => {
  const {
    orderIds, // Array of order IDs to dispatch
    dispatchMode = "VEHICLE", // VEHICLE or COURIER
    // Vehicle mode fields
    vehicleId,
    vehicleNumber,
    driverName,
    driverMobile,
    // Courier mode fields
    courierName,
    courierTrackingId,
    courierContact,
    // Common fields
    dispatchNotes,
  } = req.body;

  // Validate required fields
  if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
    return next(new AppError("At least one order ID is required", 400));
  }

  // Validate based on dispatch mode
  if (dispatchMode === "VEHICLE") {
    if (!vehicleNumber && !vehicleId) {
      return next(new AppError("Vehicle number or vehicle ID is required for vehicle dispatch", 400));
    }
    if (!driverName) {
      return next(new AppError("Driver name is required for vehicle dispatch", 400));
    }
    if (!driverMobile) {
      return next(new AppError("Driver mobile is required for vehicle dispatch", 400));
    }
  } else if (dispatchMode === "COURIER") {
    if (!courierName) {
      return next(new AppError("Courier service name is required for courier dispatch", 400));
    }
  } else {
    return next(new AppError("Invalid dispatch mode. Must be VEHICLE or COURIER", 400));
  }

  // Validate all order IDs
  for (const orderId of orderIds) {
    if (!mongoose.isValidObjectId(orderId)) {
      return next(new AppError(`Invalid order ID format: ${orderId}`, 400));
    }
  }

  // Initialize dispatch details
  let finalVehicleNumber = vehicleNumber || "";
  let finalDriverName = driverName || "";
  let finalDriverMobile = driverMobile || "";
  let finalCourierName = courierName || "";
  let finalCourierTrackingId = courierTrackingId || "";
  let finalCourierContact = courierContact || "";

  // Get vehicle details if vehicleId is provided (for VEHICLE mode)
  if (dispatchMode === "VEHICLE" && vehicleId && mongoose.isValidObjectId(vehicleId)) {
    const vehicleDetails = await Vehicle.findById(vehicleId);
    if (vehicleDetails) {
      finalVehicleNumber = vehicleDetails.number || vehicleNumber;
      // Use vehicle's driver if not provided in request
      if (!driverName && vehicleDetails.driverName) {
        finalDriverName = vehicleDetails.driverName;
      }
      if (!driverMobile && vehicleDetails.driverMobile) {
        finalDriverMobile = vehicleDetails.driverMobile;
      }
    }
  }

  // Get user info for activity log
  const userId = req.user?._id || req.user?.id;
  const userName = req.user?.name || "Unknown";
  const userRole = req.user?.role;
  const userJobTitle = req.user?.jobTitle;

  // Determine if user is admin (can dispatch directly with stock deduction)
  // or sales person (dispatching their assigned orders - stock should be deducted)
  const isAdmin = userRole === "SUPER_ADMIN" || userRole === "ADMIN" || userJobTitle === "OFFICE_ADMIN";

  // Find and update all orders - ACCEPTED or ASSIGNED orders can be dispatched
  const orders = await AgriSalesOrder.find({
    _id: { $in: orderIds },
    orderStatus: { $in: ["ACCEPTED", "ASSIGNED"] }, // ACCEPTED or ASSIGNED orders can be dispatched
  });

  if (orders.length === 0) {
    return next(new AppError("No valid orders found for dispatch. Orders must be in ACCEPTED or ASSIGNED status.", 404));
  }

  // For sales person, verify they are dispatching their own assigned orders
  const isSalesPersonDispatchingAssigned = !isAdmin && userJobTitle === "RAM_AGRI_SALES";
  
  if (isSalesPersonDispatchingAssigned) {
    const unassignedOrders = orders.filter(
      (o) => !o.assignedTo || o.assignedTo.toString() !== userId.toString()
    );
    if (unassignedOrders.length > 0) {
      return next(new AppError("You can only dispatch orders assigned to you", 403));
    }
  }

  // Update each order and deduct stock (only if admin dispatches directly)
  const updatedOrders = [];
  const dispatchedAt = new Date();
  const stockDeductionResults = [];

  for (const order of orders) {
    const previousDispatchStatus = order.dispatchStatus;
    let stockBefore = 0;
    let stockAfter = 0;
    let stockDeductionSuccess = false;

    // Determine if this order was assigned to a sales person
    const isAssignedOrder = order.assignedTo != null;

    // DEDUCT STOCK ON DISPATCH - ONLY if admin dispatches directly (not assigned orders)
    // When sales person dispatches their assigned orders, stock is NOT deducted
    const shouldDeductStock = isAdmin && !isAssignedOrder;
    
    if (shouldDeductStock && !order.stockDeducted) {
      try {
        if (order.isRamAgriProduct) {
          // Handle Ram Agri products
          const crop = await RamAgriInputsProduct.findById(order.ramAgriCropId);
          if (crop) {
            const variety = crop.varieties.id(order.ramAgriVarietyId);
            if (variety) {
              stockBefore = variety.currentStock || 0;
              
              // CHECK stock availability before deducting
              if (stockBefore < order.quantity) {
                return next(new AppError(`Insufficient stock for order ${order.orderNumber}. Available: ${stockBefore}, Required: ${order.quantity}`, 400));
              }
              
              // Deduct variety stock
              variety.currentStock = (variety.currentStock || 0) - order.quantity;
              variety.stockValue = (variety.stockValue || 0) - (order.quantity * order.rate);
              if (variety.currentStock > 0) {
                variety.averagePrice = variety.stockValue / variety.currentStock;
              } else {
                variety.averagePrice = 0;
              }
              stockAfter = variety.currentStock;
              await crop.save();
              stockDeductionSuccess = true;
            }
          }
        } else {
          // Handle regular products
          const product = await InventoryProduct.findById(order.productId);
          if (product) {
            stockBefore = product.currentStock || 0;
            
            // CHECK stock availability before deducting
            if (stockBefore < order.quantity) {
              return next(new AppError(`Insufficient stock for order ${order.orderNumber}. Available: ${stockBefore}, Required: ${order.quantity}`, 400));
            }
            
            // Deduct stock
            product.currentStock = (product.currentStock || 0) - order.quantity;
            stockAfter = product.currentStock;
            await product.save();

            // Create inventory outward transaction log
            await InventoryOutwardTransaction.create({
              productId: order.productId,
              quantity: order.quantity,
              sellingPrice: order.rate,
              totalAmount: order.totalAmount || order.quantity * order.rate,
              customer: {
                name: order.customerName,
                contact: order.customerMobile,
              },
              purpose: "sale",
              destination: "customer",
              outwardDate: new Date(),
              issuedBy: userId,
              notes: `Ram Agri Sales Order: ${order.orderNumber} (Dispatched)`,
              status: "issued",
            });
            stockDeductionSuccess = true;
          }
        }

        // Mark stock as deducted
        if (stockDeductionSuccess) {
          order.stockDeducted = true;
          order.stockDeductedAt = new Date();
        }
      } catch (stockError) {
        console.error(`Error deducting stock for order ${order.orderNumber}:`, stockError);
        return next(new AppError(`Failed to deduct stock for order ${order.orderNumber}: ${stockError.message}`, 500));
      }
    } else if (isAssignedOrder) {
      // Assigned order - no stock deduction, just mark as success for logging
      stockDeductionSuccess = false; // No stock was deducted
    } else {
      // Stock was already deducted (shouldn't happen in new flow, but handle gracefully)
      stockDeductionSuccess = true;
    }

    stockDeductionResults.push({
      orderId: order._id,
      orderNumber: order.orderNumber,
      stockDeducted: stockDeductionSuccess,
      stockBefore,
      stockAfter,
      quantityDeducted: shouldDeductStock ? order.quantity : 0,
      wasAssignedOrder: isAssignedOrder,
    });

    // Update common dispatch fields
    order.dispatchStatus = "DISPATCHED";
    order.orderStatus = "DISPATCHED"; // Update order status as well
    order.dispatchMode = dispatchMode;
    order.dispatchedAt = dispatchedAt;
    order.dispatchedBy = userId;
    order.dispatchNotes = dispatchNotes || "";

    // Update mode-specific fields
    if (dispatchMode === "VEHICLE") {
      order.vehicleId = vehicleId || null;
      order.vehicleNumber = finalVehicleNumber;
      order.driverName = finalDriverName;
      order.driverMobile = finalDriverMobile;
      // Clear courier fields
      order.courierName = "";
      order.courierTrackingId = "";
      order.courierContact = "";
    } else if (dispatchMode === "COURIER") {
      order.courierName = finalCourierName;
      order.courierTrackingId = finalCourierTrackingId;
      order.courierContact = finalCourierContact;
      // Clear vehicle fields
      order.vehicleId = null;
      order.vehicleNumber = "";
      order.driverName = "";
      order.driverMobile = "";
    }

    // Build activity log description
    const previousOrderStatus = order.orderStatus;
    let stockInfo = "";
    if (shouldDeductStock && stockDeductionSuccess) {
      stockInfo = `. Stock deducted: ${stockBefore} → ${stockAfter}`;
    } else if (isAssignedOrder) {
      stockInfo = ". (Assigned order - stock not deducted)";
    }

    let activityDescription = "";
    let newValueData = { 
      orderStatus: "DISPATCHED",
      dispatchStatus: "DISPATCHED", 
      dispatchMode, 
      stockDeducted: stockDeductionSuccess 
    };

    if (dispatchMode === "VEHICLE") {
      activityDescription = `Order dispatched via vehicle ${finalVehicleNumber} (Driver: ${finalDriverName}). Status: ${previousOrderStatus} → DISPATCHED${stockInfo}`;
      newValueData = {
        ...newValueData,
        vehicleNumber: finalVehicleNumber,
        driverName: finalDriverName,
        driverMobile: finalDriverMobile,
        stockBefore,
        stockAfter,
      };
    } else {
      activityDescription = `Order dispatched via courier ${finalCourierName}${finalCourierTrackingId ? ` (Tracking: ${finalCourierTrackingId})` : ""}. Status: ${previousOrderStatus} → DISPATCHED${stockInfo}`;
      newValueData = {
        ...newValueData,
        courierName: finalCourierName,
        courierTrackingId: finalCourierTrackingId,
        courierContact: finalCourierContact,
        stockBefore,
        stockAfter,
      };
    }

    // Add activity log
    if (!order.activityLog) order.activityLog = [];
    order.activityLog.push({
      action: "ORDER_DISPATCHED",
      description: activityDescription,
      performedBy: userId,
      performedByName: userName,
      previousValue: { orderStatus: previousOrderStatus, dispatchStatus: previousDispatchStatus, stockDeducted: order.stockDeducted },
      newValue: newValueData,
      metadata: {
        dispatchMode,
        vehicleId: dispatchMode === "VEHICLE" ? vehicleId : null,
        dispatchNotes,
        dispatchedAt,
        wasAssignedOrder: isAssignedOrder,
        stockDeductedOnDispatch: shouldDeductStock && stockDeductionSuccess,
        stockDeduction: { stockBefore, stockAfter, quantityDeducted: order.quantity },
      },
    });

    await order.save();
    updatedOrders.push(order);
  }

  // Populate fields for response
  await AgriSalesOrder.populate(updatedOrders, [
    { path: "productId" },
    { path: "createdBy" },
    { path: "dispatchedBy" },
    { path: "vehicleId" },
  ]);

  // Build response dispatch details
  const dispatchDetails = {
    dispatchMode,
    dispatchedAt,
    totalOrders: updatedOrders.length,
  };

  if (dispatchMode === "VEHICLE") {
    dispatchDetails.vehicleNumber = finalVehicleNumber;
    dispatchDetails.driverName = finalDriverName;
    dispatchDetails.driverMobile = finalDriverMobile;
  } else {
    dispatchDetails.courierName = finalCourierName;
    dispatchDetails.courierTrackingId = finalCourierTrackingId;
    dispatchDetails.courierContact = finalCourierContact;
  }

  const response = generateResponse(
    "Success",
    `${updatedOrders.length} order(s) dispatched successfully via ${dispatchMode === "VEHICLE" ? "vehicle" : "courier"}`,
    {
      dispatchedOrders: updatedOrders,
      dispatchDetails,
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== UPDATE DISPATCH STATUS ====================
// Update dispatch status (IN_TRANSIT, DELIVERED)

const updateDispatchStatus = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { dispatchStatus, notes } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  if (!["IN_TRANSIT", "DELIVERED", "NOT_DISPATCHED"].includes(dispatchStatus)) {
    return next(new AppError("Invalid dispatch status. Must be IN_TRANSIT, DELIVERED, or NOT_DISPATCHED", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  // Get user info for activity log
  const userId = req.user?._id || req.user?.id;
  const userName = req.user?.name || "Unknown";

  const previousDispatchStatus = order.dispatchStatus;

  // Update dispatch status
  order.dispatchStatus = dispatchStatus;

  // If marking as delivered, update order status to COMPLETED
  if (dispatchStatus === "DELIVERED") {
    order.orderStatus = "COMPLETED";
  }

  // If reverting to NOT_DISPATCHED, clear dispatch info
  if (dispatchStatus === "NOT_DISPATCHED") {
    order.vehicleId = null;
    order.vehicleNumber = null;
    order.driverName = null;
    order.driverMobile = null;
    order.dispatchedAt = null;
    order.dispatchedBy = null;
    order.dispatchNotes = null;
  }

  // Add activity log
  if (!order.activityLog) order.activityLog = [];
  order.activityLog.push({
    action: "DISPATCH_UPDATED",
    description: `Dispatch status changed from ${previousDispatchStatus} to ${dispatchStatus}${notes ? `: ${notes}` : ""}`,
    performedBy: userId,
    performedByName: userName,
    previousValue: { dispatchStatus: previousDispatchStatus },
    newValue: { dispatchStatus },
    metadata: { notes },
  });

  await order.save();

  // Populate fields
  await order.populate("productId");
  await order.populate("createdBy");
  await order.populate("dispatchedBy");
  await order.populate("vehicleId");

  const response = generateResponse(
    "Success",
    `Dispatch status updated to ${dispatchStatus}`,
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== COMPLETE ORDERS (Mark as Delivered with Return Handling) ====================
// Complete dispatched orders with optional return quantity - adds returned stock back to inventory

const completeOrders = catchAsync(async (req, res, next) => {
  const {
    orderIds, // Array of order IDs to complete
    returnQuantities, // Object mapping orderId to return quantity { orderId: returnQty }
    returnReason, // Common reason for returns (optional)
    returnNotes, // Additional notes (optional)
  } = req.body;

  // Validate required fields
  if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
    return next(new AppError("At least one order ID is required", 400));
  }

  // Validate all order IDs
  for (const orderId of orderIds) {
    if (!mongoose.isValidObjectId(orderId)) {
      return next(new AppError(`Invalid order ID format: ${orderId}`, 400));
    }
  }

  // Get user info for activity log
  const userId = req.user?._id || req.user?.id;
  const userName = req.user?.name || "Unknown";

  // Find all orders that can be completed (must be dispatched)
  const orders = await AgriSalesOrder.find({
    _id: { $in: orderIds },
    $or: [
      { orderStatus: "DISPATCHED" },
      { dispatchStatus: { $in: ["DISPATCHED", "IN_TRANSIT"] } }
    ]
  });

  if (orders.length === 0) {
    return next(new AppError("No valid orders found for completion. Orders must be in DISPATCHED or IN_TRANSIT status.", 404));
  }

  const completedAt = new Date();
  const updatedOrders = [];
  const stockReturnResults = [];

  for (const order of orders) {
    const orderId = order._id.toString();
    const returnQty = returnQuantities?.[orderId] || 0;
    
    // Validate return quantity
    if (returnQty < 0) {
      return next(new AppError(`Return quantity cannot be negative for order ${order.orderNumber}`, 400));
    }
    if (returnQty > order.quantity) {
      return next(new AppError(`Return quantity (${returnQty}) cannot exceed order quantity (${order.quantity}) for order ${order.orderNumber}`, 400));
    }

    const previousDispatchStatus = order.dispatchStatus;
    const previousOrderStatus = order.orderStatus;
    let stockBefore = 0;
    let stockAfter = 0;
    let stockReturnSuccess = false;

    // Calculate delivered quantity
    const deliveredQty = order.quantity - returnQty;

    // If there are returns, add stock back to inventory
    if (returnQty > 0) {
      try {
        if (order.isRamAgriProduct) {
          // Handle Ram Agri products
          const crop = await RamAgriInputsProduct.findById(order.ramAgriCropId);
          if (crop) {
            const variety = crop.varieties.id(order.ramAgriVarietyId);
            if (variety) {
              stockBefore = variety.currentStock || 0;
              
              // Add returned stock back
              variety.currentStock = (variety.currentStock || 0) + returnQty;
              // Recalculate stock value and average price
              variety.stockValue = (variety.stockValue || 0) + (returnQty * order.rate);
              if (variety.currentStock > 0) {
                variety.averagePrice = variety.stockValue / variety.currentStock;
              }
              stockAfter = variety.currentStock;
              await crop.save();
              stockReturnSuccess = true;
            }
          }
        } else {
          // Handle regular products
          const product = await InventoryProduct.findById(order.productId);
          if (product) {
            stockBefore = product.currentStock || 0;
            
            // Add returned stock back
            product.currentStock = (product.currentStock || 0) + returnQty;
            stockAfter = product.currentStock;
            await product.save();

            // Create inventory inward transaction log for returned stock
            await InventoryOutwardTransaction.create({
              productId: order.productId,
              quantity: returnQty,
              sellingPrice: order.rate,
              totalAmount: returnQty * order.rate,
              customer: {
                name: order.customerName,
                contact: order.customerMobile,
              },
              purpose: "return",
              destination: "warehouse",
              outwardDate: new Date(),
              issuedBy: userId,
              notes: `Return from Ram Agri Sales Order: ${order.orderNumber}. Reason: ${returnReason || "Customer return"}`,
              status: "returned",
            });
            stockReturnSuccess = true;
          }
        }

        // Mark stock as returned
        if (stockReturnSuccess) {
          order.stockReturned = true;
          order.stockReturnedAt = new Date();
        }
      } catch (stockError) {
        console.error(`Error returning stock for order ${order.orderNumber}:`, stockError);
        // Continue with completion even if stock return fails
      }
    }

    stockReturnResults.push({
      orderId: order._id,
      orderNumber: order.orderNumber,
      originalQuantity: order.quantity,
      returnQuantity: returnQty,
      deliveredQuantity: deliveredQty,
      stockReturned: stockReturnSuccess,
      stockBefore,
      stockAfter,
    });

    // Update order fields
    order.dispatchStatus = "DELIVERED";
    order.orderStatus = "COMPLETED";
    order.completedAt = completedAt;
    order.completedBy = userId;
    order.returnQuantity = returnQty;
    order.deliveredQuantity = deliveredQty;
    order.returnReason = returnReason || "";
    order.returnNotes = returnNotes || "";

    // Build activity log
    let activityDescription = `Order delivered and completed. Status: ${previousOrderStatus} → COMPLETED. Delivered: ${deliveredQty}/${order.quantity}`;
    if (returnQty > 0) {
      activityDescription += `. Returned: ${returnQty} (Stock: ${stockBefore} → ${stockAfter})`;
      if (returnReason) {
        activityDescription += `. Reason: ${returnReason}`;
      }
    }

    // Add activity log
    if (!order.activityLog) order.activityLog = [];
    order.activityLog.push({
      action: "ORDER_DELIVERED",
      description: activityDescription,
      performedBy: userId,
      performedByName: userName,
      previousValue: { 
        dispatchStatus: previousDispatchStatus, 
        orderStatus: previousOrderStatus 
      },
      newValue: { 
        dispatchStatus: "DELIVERED", 
        orderStatus: "COMPLETED",
        deliveredQuantity: deliveredQty,
        returnQuantity: returnQty,
      },
      metadata: {
        originalQuantity: order.quantity,
        deliveredQuantity: deliveredQty,
        returnQuantity: returnQty,
        returnReason,
        returnNotes,
        stockReturn: returnQty > 0 ? { stockBefore, stockAfter, success: stockReturnSuccess } : null,
      },
    });

    // If stock was returned, add separate activity log entry
    if (returnQty > 0 && stockReturnSuccess) {
      order.activityLog.push({
        action: "STOCK_RETURNED",
        description: `${returnQty} units returned to inventory (Stock: ${stockBefore} → ${stockAfter})`,
        performedBy: userId,
        performedByName: userName,
        previousValue: { stock: stockBefore },
        newValue: { stock: stockAfter },
        metadata: {
          returnQuantity: returnQty,
          returnReason,
        },
      });
    }

    await order.save();
    updatedOrders.push(order);
  }

  // Populate fields for response
  await AgriSalesOrder.populate(updatedOrders, [
    { path: "productId" },
    { path: "createdBy" },
    { path: "dispatchedBy" },
    { path: "completedBy" },
    { path: "vehicleId" },
  ]);

  const response = generateResponse(
    "Success",
    `${updatedOrders.length} order(s) completed successfully`,
    {
      orders: updatedOrders,
      summary: {
        totalCompleted: updatedOrders.length,
        totalReturns: stockReturnResults.filter(r => r.returnQuantity > 0).length,
        stockReturnResults,
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== PROCESS SALES RETURN (For Sales Person Dispatched Orders) ====================
// Process returns for orders dispatched by sales person - NO stock impact, but can adjust payments

const processSalesReturn = catchAsync(async (req, res, next) => {
  const { id } = req.params; // Order ID
  const {
    returnQuantity,
    returnReason,
    returnNotes,
    paymentAdjustments, // Array of payment adjustments: [{ amount: -100, adjustmentType: "REFUND", reason: "...", notes: "..." }]
  } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  // Validate: Only sales person who dispatched the order (or assigned order) can process returns
  const userId = req.user?._id || req.user?.id;
  const userName = req.user?.name || "Unknown";
  const isAdmin = req.user?.role === "SUPER_ADMIN" || req.user?.jobTitle === "OFFICE_ADMIN";
  const isAssignedOrder = order.assignedTo != null;
  const wasDispatchedBySalesPerson = order.dispatchedBy && order.dispatchedBy.toString() === userId.toString();

  // Only allow if:
  // 1. Order was assigned to the user and they dispatched it, OR
  // 2. Admin is processing return for any dispatched order
  if (!isAdmin && !(isAssignedOrder && wasDispatchedBySalesPerson)) {
    return next(new AppError("You can only process returns for orders you dispatched", 403));
  }

  // Order must be dispatched
  if (!order.dispatchedAt || order.dispatchStatus === "NOT_DISPATCHED") {
    return next(new AppError("Order must be dispatched before processing sales return", 400));
  }

  // Validate return quantity
  const returnQty = parseFloat(returnQuantity) || 0;
  if (returnQty < 0) {
    return next(new AppError("Return quantity cannot be negative", 400));
  }
  if (returnQty > order.quantity) {
    return next(new AppError(`Return quantity (${returnQty}) cannot exceed order quantity (${order.quantity})`, 400));
  }

  const previousSalesReturnQty = order.salesReturnQuantity || 0;
  const previousTotalPaid = order.totalPaidAmount || 0;

  // Update sales return fields
  order.salesReturnQuantity = returnQty;
  order.salesReturnReason = returnReason || "";
  order.salesReturnNotes = returnNotes || "";
  order.salesReturnedAt = new Date();
  order.salesReturnedBy = userId;

  // Calculate delivered quantity (considering sales return, but separate from regular return)
  const salesDeliveredQty = order.quantity - returnQty;

  // Process payment adjustments (if any)
  if (paymentAdjustments && Array.isArray(paymentAdjustments) && paymentAdjustments.length > 0) {
    if (!order.paymentAdjustments) {
      order.paymentAdjustments = [];
    }

    let totalAdjustment = 0;
    for (const adjustment of paymentAdjustments) {
      const { amount, adjustmentType, reason, notes, paymentId } = adjustment;
      
      if (typeof amount !== "number") {
        return next(new AppError("Payment adjustment amount must be a number", 400));
      }
      if (!["REFUND", "CREDIT", "ADJUSTMENT", "DEDUCTION"].includes(adjustmentType)) {
        return next(new AppError(`Invalid adjustment type: ${adjustmentType}`, 400));
      }

      order.paymentAdjustments.push({
        amount,
        adjustmentType,
        reason: reason || "",
        notes: notes || "",
        adjustedAt: new Date(),
        adjustedBy: userId,
        adjustedByName: userName,
        paymentId: paymentId || null,
      });

      totalAdjustment += amount; // amount can be negative for refunds
    }

    // Update total paid amount (adjustments can be negative)
    order.totalPaidAmount = Math.max(0, previousTotalPaid + totalAdjustment);
    order.balanceAmount = order.totalAmount - order.totalPaidAmount;

    // Update payment status
    if (order.totalPaidAmount === 0) {
      order.paymentStatus = "PENDING";
    } else if (order.totalPaidAmount >= order.totalAmount) {
      order.paymentStatus = "COMPLETED";
    } else {
      order.paymentStatus = "PARTIAL";
    }
  }

  // Build activity log description
  let activityDescription = `Sales return processed. Returned: ${returnQty}/${order.quantity}. Delivered: ${salesDeliveredQty}. `;
  if (returnReason) {
    activityDescription += `Reason: ${returnReason}. `;
  }
  if (paymentAdjustments && paymentAdjustments.length > 0) {
    const totalAdjustment = paymentAdjustments.reduce((sum, adj) => sum + adj.amount, 0);
    activityDescription += `Payment adjusted: ${previousTotalPaid} → ${order.totalPaidAmount} (${totalAdjustment >= 0 ? '+' : ''}${totalAdjustment.toFixed(2)}). `;
  }
  activityDescription += `(NO stock impact - order was dispatched by sales person)`;

  // Add activity log
  if (!order.activityLog) order.activityLog = [];
  
  // Log sales return
  order.activityLog.push({
    action: "SALES_RETURN_PROCESSED",
    description: activityDescription,
    performedBy: userId,
    performedByName: userName,
    previousValue: {
      salesReturnQuantity: previousSalesReturnQty,
      totalPaidAmount: previousTotalPaid,
      paymentStatus: order.paymentStatus, // Will be updated below if adjustments exist
    },
    newValue: {
      salesReturnQuantity: returnQty,
      salesDeliveredQuantity: salesDeliveredQty,
      totalPaidAmount: order.totalPaidAmount,
      paymentStatus: order.paymentStatus,
    },
    metadata: {
      returnReason,
      returnNotes,
      isAssignedOrder,
      dispatchedBy: order.dispatchedBy,
    },
  });

  // Log payment adjustments separately if any
  if (paymentAdjustments && paymentAdjustments.length > 0) {
    for (const adjustment of paymentAdjustments) {
      order.activityLog.push({
        action: "PAYMENT_ADJUSTED",
        description: `Payment ${adjustment.adjustmentType.toLowerCase()}: ${adjustment.amount >= 0 ? '+' : ''}${adjustment.amount.toFixed(2)}. ${adjustment.reason || ""} ${adjustment.notes || ""}`.trim(),
        performedBy: userId,
        performedByName: userName,
        previousValue: {
          totalPaidAmount: previousTotalPaid,
        },
        newValue: {
          totalPaidAmount: order.totalPaidAmount,
          adjustmentAmount: adjustment.amount,
          adjustmentType: adjustment.adjustmentType,
        },
        metadata: {
          reason: adjustment.reason,
          notes: adjustment.notes,
          paymentId: adjustment.paymentId,
        },
      });
    }
  }

  await order.save();

  // Populate fields for response
  await order.populate("productId");
  await order.populate("createdBy");
  await order.populate("dispatchedBy");
  await order.populate("assignedTo");
  await order.populate("salesReturnedBy");

  const response = generateResponse(
    "Success",
    "Sales return processed successfully",
    {
      order,
      summary: {
        returnQuantity: returnQty,
        deliveredQuantity: salesDeliveredQty,
        originalQuantity: order.quantity,
        paymentAdjustments: paymentAdjustments?.length || 0,
        previousTotalPaid: previousTotalPaid,
        newTotalPaid: order.totalPaidAmount,
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET ORDERS FOR DISPATCH ====================
// Get orders that are ready for dispatch (ACCEPTED status, not yet dispatched)

const getOrdersForDispatch = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 100,
    search,
    customerVillage,
    customerTaluka,
    customerDistrict,
    startDate,
    endDate,
  } = req.query;

  let query = AgriSalesOrder.find({
    orderStatus: { $in: ["PENDING", "ACCEPTED"] },
    dispatchStatus: "NOT_DISPATCHED",
  });

  // Search filter
  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { customerName: searchRegex },
      { customerMobile: searchRegex },
      { orderNumber: searchRegex },
      { productName: searchRegex },
    ]);
  }

  // Location filters
  if (customerVillage) {
    query = query.where("customerVillage").equals(customerVillage);
  }
  if (customerTaluka) {
    query = query.where("customerTaluka").equals(customerTaluka);
  }
  if (customerDistrict) {
    query = query.where("customerDistrict").equals(customerDistrict);
  }

  // Date range filter
  if (startDate || endDate) {
    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query = query.where("orderDate").gte(start).lte(end);
    } else if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      query = query.where("orderDate").gte(start);
    } else if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query = query.where("orderDate").lte(end);
    }
  }

  // Sort by order date
  query = query.sort({ orderDate: -1 });

  // Pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  // Populate references
  query = query.populate("productId").populate("createdBy");

  const [orders, total] = await Promise.all([
    query.exec(),
    AgriSalesOrder.countDocuments(query.getFilter()),
  ]);

  const response = generateResponse(
    "Success",
    "Orders for dispatch fetched successfully",
    {
      data: orders,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET DISPATCHED ORDERS ====================
// Get orders that have been dispatched

const getDispatchedOrders = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 100,
    search,
    dispatchStatus, // DISPATCHED, IN_TRANSIT, DELIVERED
    startDate,
    endDate,
  } = req.query;

  let query = AgriSalesOrder.find({
    dispatchStatus: { $ne: "NOT_DISPATCHED" },
  });

  // Filter by specific dispatch status
  if (dispatchStatus && ["DISPATCHED", "IN_TRANSIT", "DELIVERED"].includes(dispatchStatus)) {
    query = query.where("dispatchStatus").equals(dispatchStatus);
  }

  // Search filter
  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { customerName: searchRegex },
      { customerMobile: searchRegex },
      { orderNumber: searchRegex },
      { productName: searchRegex },
      { vehicleNumber: searchRegex },
      { driverName: searchRegex },
    ]);
  }

  // Date range filter (by dispatch date)
  if (startDate || endDate) {
    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query = query.where("dispatchedAt").gte(start).lte(end);
    } else if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      query = query.where("dispatchedAt").gte(start);
    } else if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query = query.where("dispatchedAt").lte(end);
    }
  }

  // Sort by dispatch date
  query = query.sort({ dispatchedAt: -1 });

  // Pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  // Populate references
  query = query
    .populate("productId")
    .populate("createdBy")
    .populate("dispatchedBy")
    .populate("vehicleId");

  const [orders, total] = await Promise.all([
    query.exec(),
    AgriSalesOrder.countDocuments(query.getFilter()),
  ]);

  const response = generateResponse(
    "Success",
    "Dispatched orders fetched successfully",
    {
      data: orders,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

export {
  createAgriSalesOrder,
  updateAgriSalesOrder,
  acceptAgriSalesOrder,
  rejectAgriSalesOrder,
  cancelAgriSalesOrder,
  getAllAgriSalesOrders,
  getAgriSalesOrderById,
  addPaymentToAgriSalesOrder,
  updatePaymentStatus,
  getCustomerByMobile,
  getPendingPayments,
  getPendingPaymentsCount,
  getOutstandingAnalysis,
  getSalesAnalysis,
  getCustomerOutstanding,
  assignOrdersToSalesPerson,
  getAssignedOrders,
  cancelAssignment,
  dispatchOrders,
  updateDispatchStatus,
  completeOrders,
  processSalesReturn,
  getOrdersForDispatch,
  getDispatchedOrders,
};

