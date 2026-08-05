import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import APIFeatures from "../utility/apiFeatures.js";
import { InventoryProduct, InventoryBatch, InventoryInward, InventoryOutwardTransaction, StockAdjustment } from "../models/inventory.model.js";
import mongoose from "mongoose";
import { scheduleStockInwardAlert, scheduleStockChangeAlert } from "../services/stockWhatsappAlert.service.js";

// ==================== PRODUCT CONTROLLERS ====================

const createProduct = catchAsync(async (req, res, next) => {
  const {
    name,
    description,
    category,
    unit,
    minStockLevel,
    maxStockLevel,
    costPrice,
    sellingPrice,
    supplier,
    image,
    tags,
    isAgriSales,
  } = req.body;

  const existingProduct = await InventoryProduct.findOne({ name, category });
  if (existingProduct) {
    return next(new AppError("Product with this name and category already exists", 409));
  }

  const product = await InventoryProduct.create({
    name,
    description,
    category,
    unit,
    minStockLevel,
    maxStockLevel,
    costPrice,
    sellingPrice,
    supplier,
    image,
    tags,
    isAgriSales: isAgriSales || false,
  });

  const response = generateResponse(
    "Success",
    "Product created successfully",
    product,
    undefined
  );

  return res.status(201).json(response);
});

const getAllProducts = catchAsync(async (req, res, next) => {
  const {
    sortKey = "createdAt",
    sortOrder = "desc",
    search,
    category,
    status,
    isActive,
    isAgriSales,
  } = req.query;

  let query = InventoryProduct.find();

  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { name: searchRegex },
      { description: searchRegex },
      { "supplier.name": searchRegex },
    ]);
  }

  if (category) {
    query = query.where("category").equals(category);
  }

  // Support both 'status' and 'isActive' parameters for backward compatibility
  if (status !== undefined) {
    query = query.where("isActive").equals(status === "true");
  } else if (isActive !== undefined) {
    query = query.where("isActive").equals(isActive === "true");
  }

  if (isAgriSales !== undefined) {
    query = query.where("isAgriSales").equals(isAgriSales === "true");
  }

  const sort = {};
  sort[sortKey] = sortOrder === "desc" ? -1 : 1;
  query = query.sort(sort);

  // IMPORTANT: No pagination at backend.
  // This endpoint returns the full filtered/sorted product list to simplify UI.
  const products = await query.exec();

  const response = generateResponse(
    "Success",
    "Products fetched successfully",
    {
      data: products,
    },
    undefined
  );

  return res.status(200).json(response);
});

const getProductById = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid product ID format", 400));
  }

  // List + create for the nursery app use the Product model (product.controller).
  // Legacy InventoryProduct IDs are still supported below.
  const { default: Product } = await import("../models/product.model.js");
  const existsInProduct = await Product.exists({ _id: id });
  if (existsInProduct) {
    const { getProductById: getProductByIdFromProduct } = await import(
      "./product.controller.js"
    );
    return getProductByIdFromProduct(req, res);
  }

  const product = await InventoryProduct.findById(id);
  if (!product) {
    return next(new AppError("No product found with that ID", 404));
  }

  const response = generateResponse(
    "Success",
    "Product fetched successfully",
    product,
    undefined
  );

  return res.status(200).json(response);
});

const updateProduct = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const updateData = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid product ID format", 400));
  }

  const existingProduct = await InventoryProduct.findById(id);
  if (!existingProduct) {
    return next(new AppError("No product found with that ID", 404));
  }

  // Check for duplicate name and category if being updated
  if (updateData.name && updateData.category) {
    const duplicateProduct = await InventoryProduct.findOne({
      name: updateData.name,
      category: updateData.category,
      _id: { $ne: id },
    });
    if (duplicateProduct) {
      return next(new AppError("Product with this name and category already exists", 409));
    }
  }

  const product = await InventoryProduct.findByIdAndUpdate(id, updateData, {
    new: true,
    runValidators: true,
  });

  const response = generateResponse(
    "Success",
    "Product updated successfully",
    product,
    undefined
  );

  return res.status(200).json(response);
});

const deleteProduct = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid product ID format", 400));
  }

  const product = await InventoryProduct.findById(id);
  if (!product) {
    return next(new AppError("No product found with that ID", 404));
  }

  // Check if product has any stock or transactions
  const hasStock = product.currentStock > 0;
  const hasBatches = await InventoryBatch.exists({ productId: id });
  const hasTransactions = await InventoryInward.exists({ productId: id }) || 
                         await InventoryOutwardTransaction.exists({ productId: id });

  if (hasStock || hasBatches || hasTransactions) {
    return next(new AppError("Cannot delete product with existing stock or transactions", 400));
  }

  await InventoryProduct.findByIdAndDelete(id);

  const response = generateResponse(
    "Success",
    "Product deleted successfully",
    null,
    undefined
  );

  return res.status(200).json(response);
});

const toggleProductStatus = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { isActive } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid product ID format", 400));
  }

  const product = await InventoryProduct.findByIdAndUpdate(
    id,
    { isActive },
    {
      new: true,
      runValidators: true,
    }
  );

  if (!product) {
    return next(new AppError("No product found with that ID", 404));
  }

  const response = generateResponse(
    "Success",
    `Product ${isActive ? "activated" : "deactivated"} successfully`,
    product,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== BATCH CONTROLLERS ====================

const createBatch = catchAsync(async (req, res, next) => {
  const {
    productId,
    batchNumber,
    quantity,
    manufacturingDate,
    expiryDate,
    costPrice,
    supplier,
    receivedBy,
    notes,
  } = req.body;

  if (!mongoose.isValidObjectId(productId)) {
    return next(new AppError("Invalid product ID format", 400));
  }

  const product = await InventoryProduct.findById(productId);
  if (!product) {
    return next(new AppError("Product not found", 404));
  }

  // Check for duplicate batch number for the same product
  const existingBatch = await InventoryBatch.findOne({
    productId,
    batchNumber,
  });
  if (existingBatch) {
    return next(new AppError("Batch number already exists for this product", 409));
  }

  const batch = await InventoryBatch.create({
    productId,
    batchNumber,
    quantity,
    receivedQuantity: quantity,
    remainingQuantity: quantity,
    manufacturingDate,
    expiryDate,
    costPrice,
    supplier,
    receivedBy,
    notes,
  });

  // Update product current stock
  await InventoryProduct.findByIdAndUpdate(productId, {
    $inc: { currentStock: quantity },
  });

  const response = generateResponse(
    "Success",
    "Batch created successfully",
    batch,
    undefined
  );

  return res.status(201).json(response);
});

const getAllBatches = catchAsync(async (req, res, next) => {
  const {
    productId,
    sortKey = "createdAt",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 10,
    status,
  } = req.query;

  let query = InventoryBatch.find().populate("productId", "name category unit");

  if (productId) {
    if (!mongoose.isValidObjectId(productId)) {
      return next(new AppError("Invalid product ID format", 400));
    }
    query = query.where("productId").equals(productId);
  }

  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { batchNumber: searchRegex },
      { "supplier.name": searchRegex },
    ]);
  }

  if (status) {
    query = query.where("status").equals(status);
  }

  const sort = {};
  sort[sortKey] = sortOrder === "desc" ? -1 : 1;
  query = query.sort(sort);

  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  const [batches, total] = await Promise.all([
    query.exec(),
    InventoryBatch.countDocuments(query.getFilter()),
  ]);

  const response = generateResponse(
    "Success",
    "Batches fetched successfully",
    {
      data: batches,
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

// ==================== INWARD CONTROLLERS ====================

const createInward = catchAsync(async (req, res, next) => {
  const {
    productId,
    batchId,
    quantity,
    costPrice,
    supplier,
    invoiceNumber,
    receivedBy,
    notes,
  } = req.body;

  if (!mongoose.isValidObjectId(productId)) {
    return next(new AppError("Invalid product ID format", 400));
  }

  const product = await InventoryProduct.findById(productId);
  if (!product) {
    return next(new AppError("Product not found", 404));
  }

  let batch = null;
  let batchIdToUse = null;

  // If batchId is provided, validate it
  if (batchId) {
    if (!mongoose.isValidObjectId(batchId)) {
      return next(new AppError("Invalid batch ID format", 400));
    }
    
    batch = await InventoryBatch.findById(batchId);
    if (!batch) {
      return next(new AppError("Batch not found", 404));
    }
    
    if (batch.productId.toString() !== productId) {
      return next(new AppError("Batch does not belong to the specified product", 400));
    }
    
    batchIdToUse = batchId;
  } else {
    // Create a new batch if no batch is specified
    const batchNumber = `BATCH-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    batch = await InventoryBatch.create({
      productId,
      batchNumber,
      quantity: 0,
      receivedQuantity: 0,
      remainingQuantity: 0,
      costPrice,
      supplier,
      receivedBy,
      notes: `Auto-generated batch for inward transaction`,
    });
    batchIdToUse = batch._id;
  }

  const totalAmount = quantity * costPrice;

  const inward = await InventoryInward.create({
    productId,
    batchId: batchIdToUse,
    quantity,
    costPrice,
    totalAmount,
    supplier,
    invoiceNumber,
    receivedBy,
    notes,
  });

  // Update batch received quantity
  await InventoryBatch.findByIdAndUpdate(batchIdToUse, {
    $inc: { receivedQuantity: quantity, remainingQuantity: quantity },
  });

  // Update product current stock
  const updatedProduct = await InventoryProduct.findByIdAndUpdate(
    productId,
    { $inc: { currentStock: quantity } },
    { new: true }
  );

  scheduleStockInwardAlert({
    productName: product.name,
    quantity,
    unit: product.unit || "",
    referenceNumber: invoiceNumber || inward._id?.toString(),
    supplierName: typeof supplier === "object" ? supplier?.name : supplier || "",
    newStock: updatedProduct?.currentStock,
    performedByName: req.user?.name || "System",
    source: "Inventory Inward",
  });

  const response = generateResponse(
    "Success",
    "Inward transaction created successfully",
    inward,
    undefined
  );

  return res.status(201).json(response);
});

const getAllInwards = catchAsync(async (req, res, next) => {
  const {
    productId,
    sortKey = "createdAt",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 10,
    status,
    startDate,
    endDate,
  } = req.query;

  let query = InventoryInward.find()
    .populate("productId", "name category unit")
    .populate("batchId", "batchNumber")
    .populate("receivedBy", "name");

  if (productId) {
    if (!mongoose.isValidObjectId(productId)) {
      return next(new AppError("Invalid product ID format", 400));
    }
    query = query.where("productId").equals(productId);
  }

  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { invoiceNumber: searchRegex },
      { "supplier.name": searchRegex },
    ]);
  }

  if (status) {
    query = query.where("status").equals(status);
  }

  if (startDate && endDate) {
    query = query.where("receivedDate").gte(new Date(startDate)).lte(new Date(endDate));
  }

  const sort = {};
  sort[sortKey] = sortOrder === "desc" ? -1 : 1;
  query = query.sort(sort);

  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  const [inwards, total] = await Promise.all([
    query.exec(),
    InventoryInward.countDocuments(query.getFilter()),
  ]);

  const response = generateResponse(
    "Success",
    "Inward transactions fetched successfully",
    {
      data: inwards,
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

// ==================== OUTWARD CONTROLLERS ====================

const createOutward = catchAsync(async (req, res, next) => {
  const {
    productId,
    batchId,
    quantity,
    sellingPrice,
    customer,
    purpose,
    destination,
    issuedBy,
    notes,
  } = req.body;

  if (!mongoose.isValidObjectId(productId)) {
    return next(new AppError("Invalid product ID format", 400));
  }

  const product = await InventoryProduct.findById(productId);
  if (!product) {
    return next(new AppError("Product not found", 404));
  }

  // Check if enough stock is available
  if (product.currentStock < quantity) {
    return next(new AppError("Insufficient stock available", 400));
  }

  let batch = null;
  if (batchId) {
    if (!mongoose.isValidObjectId(batchId)) {
      return next(new AppError("Invalid batch ID format", 400));
    }
    batch = await InventoryBatch.findById(batchId);
    if (!batch) {
      return next(new AppError("Batch not found", 404));
    }
    if (batch.remainingQuantity < quantity) {
      return next(new AppError("Insufficient quantity in selected batch", 400));
    }
  }

  const totalAmount = sellingPrice ? quantity * sellingPrice : 0;

  const outward = await InventoryOutwardTransaction.create({
    productId,
    batchId,
    quantity,
    sellingPrice,
    totalAmount,
    customer,
    purpose,
    destination,
    issuedBy,
    notes,
  });

  // Update batch remaining quantity if batch is specified
  if (batch) {
    await InventoryBatch.findByIdAndUpdate(batchId, {
      $inc: { remainingQuantity: -quantity },
    });
  }

  // Update product current stock
  const updatedProduct = await InventoryProduct.findByIdAndUpdate(
    productId,
    { $inc: { currentStock: -quantity } },
    { new: true }
  );

  scheduleStockChangeAlert({
    changeType: "outward",
    productName: product.name,
    quantity,
    unit: product.unit || "",
    referenceNumber: outward._id?.toString(),
    newStock: updatedProduct?.currentStock,
    performedByName: req.user?.name || issuedBy || "System",
    source: "Inventory Outward",
    notes: purpose || notes || undefined,
  });

  const response = generateResponse(
    "Success",
    "Outward transaction created successfully",
    outward,
    undefined
  );

  return res.status(201).json(response);
});

const getAllOutwards = catchAsync(async (req, res, next) => {
  const {
    productId,
    sortKey = "createdAt",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 10,
    status,
    purpose,
    startDate,
    endDate,
  } = req.query;

  let query = InventoryOutwardTransaction.find()
    .populate("productId", "name category unit")
    .populate("batchId", "batchNumber")
    .populate("issuedBy", "name");

  if (productId) {
    if (!mongoose.isValidObjectId(productId)) {
      return next(new AppError("Invalid product ID format", 400));
    }
    query = query.where("productId").equals(productId);
  }

  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { "customer.name": searchRegex },
      { notes: searchRegex },
    ]);
  }

  if (status) {
    query = query.where("status").equals(status);
  }

  if (purpose) {
    query = query.where("purpose").equals(purpose);
  }

  if (startDate && endDate) {
    query = query.where("outwardDate").gte(new Date(startDate)).lte(new Date(endDate));
  }

  const sort = {};
  sort[sortKey] = sortOrder === "desc" ? -1 : 1;
  query = query.sort(sort);

  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  const [outwards, total] = await Promise.all([
    query.exec(),
    InventoryOutwardTransaction.countDocuments(query.getFilter()),
  ]);

  const response = generateResponse(
    "Success",
    "Outward transactions fetched successfully",
    {
      data: outwards,
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

// ==================== STOCK ADJUSTMENT CONTROLLERS ====================

const createStockAdjustment = catchAsync(async (req, res, next) => {
  const {
    productId,
    batchId,
    adjustmentType,
    quantity,
    reason,
    adjustedBy,
    notes,
  } = req.body;

  if (!mongoose.isValidObjectId(productId)) {
    return next(new AppError("Invalid product ID format", 400));
  }

  const product = await InventoryProduct.findById(productId);
  if (!product) {
    return next(new AppError("Product not found", 404));
  }

  let batch = null;
  if (batchId) {
    if (!mongoose.isValidObjectId(batchId)) {
      return next(new AppError("Invalid batch ID format", 400));
    }
    batch = await InventoryBatch.findById(batchId);
    if (!batch) {
      return next(new AppError("Batch not found", 404));
    }
  }

  // Validate quantity based on adjustment type
  let stockChange = 0;
  if (adjustmentType === "addition") {
    stockChange = quantity;
  } else if (adjustmentType === "subtraction") {
    stockChange = -quantity;
    if (product.currentStock < quantity) {
      return next(new AppError("Insufficient stock for adjustment", 400));
    }
  } else if (adjustmentType === "correction") {
    stockChange = quantity - product.currentStock;
  }

  const adjustment = await StockAdjustment.create({
    productId,
    batchId,
    adjustmentType,
    quantity,
    reason,
    adjustedBy,
    notes,
  });

  // Update product current stock
  const updatedProduct = await InventoryProduct.findByIdAndUpdate(
    productId,
    { $inc: { currentStock: stockChange } },
    { new: true }
  );

  // Update batch remaining quantity if batch is specified
  if (batch && adjustmentType !== "correction") {
    await InventoryBatch.findByIdAndUpdate(batchId, {
      $inc: { remainingQuantity: stockChange },
    });
  }

  scheduleStockChangeAlert({
    changeType: "adjustment",
    productName: product.name,
    quantity: stockChange,
    unit: product.unit || "",
    referenceNumber: adjustment._id?.toString(),
    newStock: updatedProduct?.currentStock,
    adjustmentType,
    reason: reason || notes,
    performedByName: req.user?.name || adjustedBy || "System",
    source: "Stock Adjustment",
  });

  const response = generateResponse(
    "Success",
    "Stock adjustment created successfully",
    adjustment,
    undefined
  );

  return res.status(201).json(response);
});

// ==================== INVENTORY SUMMARY ====================

const getInventorySummary = catchAsync(async (req, res, next) => {
  const [
    totalProducts,
    activeProducts,
    lowStockCount,
    totalStockValue,
    categoryWiseStock,
  ] = await Promise.all([
    InventoryProduct.countDocuments(),
    InventoryProduct.countDocuments({ isActive: true }),
    InventoryProduct.countDocuments({
      isActive: true,
      $expr: { $lte: ["$currentStock", "$minStockLevel"] },
    }),
    InventoryProduct.aggregate([
      { $match: { isActive: true } },
      {
        $group: {
          _id: null,
          total: { $sum: { $multiply: ["$currentStock", "$costPrice"] } },
        },
      },
    ]),
    InventoryProduct.aggregate([
      { $match: { isActive: true } },
      {
        $group: {
          _id: "$category",
          count: { $sum: 1 },
          totalValue: { $sum: { $multiply: ["$currentStock", "$costPrice"] } },
          totalStock: { $sum: "$currentStock" },
        },
      },
    ]),
  ]);

  const response = generateResponse(
    "Success",
    "Inventory summary fetched successfully",
    {
      totalProducts,
      activeProducts,
      lowStockCount,
      totalStockValue: totalStockValue[0]?.total || 0,
      categoryWiseStock,
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== INVENTORY DASHBOARD ====================

const getInventoryDashboard = catchAsync(async (req, res, next) => {
  const [
    totalProducts,
    activeProducts,
    lowStockProducts,
    totalStockValue,
    recentInwards,
    recentOutwards,
    categoryStats,
  ] = await Promise.all([
    InventoryProduct.countDocuments(),
    InventoryProduct.countDocuments({ isActive: true }),
    InventoryProduct.countDocuments({ $expr: { $lte: ["$currentStock", "$minStockLevel"] } }),
    InventoryProduct.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: null, totalValue: { $sum: { $multiply: ["$currentStock", "$costPrice"] } } } },
    ]),
    InventoryInward.find()
      .populate("productId", "name category")
      .sort({ createdAt: -1 })
      .limit(5),
    InventoryOutwardTransaction.find()
      .populate("productId", "name category")
      .sort({ createdAt: -1 })
      .limit(5),
    InventoryProduct.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: "$category", count: { $sum: 1 }, totalStock: { $sum: "$currentStock" } } },
    ]),
  ]);

  const dashboardData = {
    summary: {
      totalProducts,
      activeProducts,
      lowStockProducts,
      totalStockValue: totalStockValue[0]?.totalValue || 0,
    },
    recentTransactions: {
      inwards: recentInwards,
      outwards: recentOutwards,
    },
    categoryStats,
  };

  const response = generateResponse(
    "Success",
    "Inventory dashboard data fetched successfully",
    dashboardData,
    undefined
  );

  return res.status(200).json(response);
});

export {
  // Product controllers
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  deleteProduct,
  toggleProductStatus,
  
  // Batch controllers
  createBatch,
  getAllBatches,
  
  // Inward controllers
  createInward,
  getAllInwards,
  
  // Outward controllers
  createOutward,
  getAllOutwards,
  
  // Stock adjustment controllers
  createStockAdjustment,
  
  // Summary
  getInventorySummary,
  
  // Dashboard
  getInventoryDashboard,
}; 