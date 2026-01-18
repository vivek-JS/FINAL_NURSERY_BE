import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import APIFeatures from "../utility/apiFeatures.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import { InventoryProduct, InventoryOutwardTransaction, StockAdjustment } from "../models/inventory.model.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";
import Farmer from "../models/farmer.model.js";
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

    // Check variety stock
    currentStock = variety.currentStock || 0;
    if (currentStock < quantity) {
      return next(new AppError(`Insufficient stock. Available: ${currentStock}, Required: ${quantity}`, 400));
    }

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

    // Check stock availability (but don't deduct yet - wait for acceptance)
    currentStock = product.currentStock || 0;
    if (currentStock < quantity) {
      return next(new AppError(`Insufficient stock. Available: ${currentStock}, Required: ${quantity}`, 400));
    }

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

// ==================== ACCEPT ORDER & DEDUCT STOCK ====================

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

  let stockBefore = 0;
  let stockAfter = 0;

  // Handle Ram Agri products
  if (order.isRamAgriProduct) {
    const crop = await RamAgriInputsProduct.findById(order.ramAgriCropId);
    if (!crop) {
      return next(new AppError("Crop not found", 404));
    }

    const variety = crop.varieties.id(order.ramAgriVarietyId);
    if (!variety) {
      return next(new AppError("Variety not found", 404));
    }

    // Check stock availability again
    stockBefore = variety.currentStock || 0;
    if (stockBefore < order.quantity) {
      return next(new AppError(`Insufficient stock. Available: ${stockBefore}, Required: ${order.quantity}`, 400));
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
  } else {
    // Handle regular products
    const product = await InventoryProduct.findById(order.productId);
    if (!product) {
      return next(new AppError("Product not found", 404));
    }

    // Check stock availability again
    stockBefore = product.currentStock || 0;
    if (stockBefore < order.quantity) {
      return next(new AppError(`Insufficient stock. Available: ${stockBefore}, Required: ${order.quantity}`, 400));
    }

    // Deduct stock
    product.currentStock -= order.quantity;
    stockAfter = product.currentStock;
    await product.save();

    // Create inventory outward transaction log (only for regular products)
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
      issuedBy: req.user?._id || req.user?.id,
      notes: `Ram Agri Sales Order: ${order.orderNumber}`,
      status: "issued",
    });
  }

  // Update order status
  order.orderStatus = "ACCEPTED";
  order.stockDeducted = true;
  order.stockDeductedAt = new Date();
  order.acceptedBy = req.user?._id || req.user?.id;
  order.acceptedAt = new Date();
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
    "Order accepted and stock deducted successfully",
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

  // Can reject PENDING orders, or cancel ACCEPTED orders (add stock back)
  if (order.orderStatus !== "PENDING" && order.orderStatus !== "ACCEPTED") {
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

  // Update order status
  order.orderStatus = "REJECTED";
  order.stockDeducted = false;
  order.stockDeductedAt = null;
  if (reason) {
    if (!order.remarks) order.remarks = [];
    order.remarks.push(`Rejected: ${reason}`);
  }
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
  query = query.populate("productId").populate("createdBy").populate("acceptedBy");

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
    .populate("acceptedBy");

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

  // Update payment status
  order.payment[index].paymentStatus = paymentStatus;
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

  // Update order fields
  Object.keys(filteredData).forEach((key) => {
    order[key] = filteredData[key];
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
};

