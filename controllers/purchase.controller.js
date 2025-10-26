import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import { PurchaseOrderTransaction, GRNTransaction, ProductDispatch, SellOrder } from "../models/purchase.model.js";
import { InventoryProduct, InventoryBatch, InventoryInward } from "../models/inventory.model.js";
import mongoose from "mongoose";

// ==================== PURCHASE ORDER CONTROLLERS ====================

const createPurchaseOrder = catchAsync(async (req, res, next) => {
  const {
    supplier,
    expectedDeliveryDate,
    items,
    notes,
  } = req.body;

  // Validate items
  if (!items || items.length === 0) {
    return next(new AppError("At least one item is required", 400));
  }

  // Validate each item and calculate amounts
  let totalAmount = 0;
  for (const item of items) {
    if (!mongoose.isValidObjectId(item.productId)) {
      return next(new AppError("Invalid product ID format", 400));
    }

    const product = await InventoryProduct.findById(item.productId);
    if (!product) {
      return next(new AppError(`Product not found for ID: ${item.productId}`, 404));
    }

    item.unit = product.unit;
    item.amount = item.quantity * item.rate;
    totalAmount += item.amount;
  }

  const purchaseOrder = await PurchaseOrderTransaction.create({
    supplier,
    expectedDeliveryDate,
    items,
    totalAmount,
    notes,
    createdBy: req.user?.id,
  });

  const response = generateResponse(
    "Success",
    "Purchase order created successfully",
    purchaseOrder,
    undefined
  );

  return res.status(201).json(response);
});

const getAllPurchaseOrders = catchAsync(async (req, res, next) => {
  const {
    sortKey = "createdAt",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 10,
    status,
    startDate,
    endDate,
  } = req.query;

  let query = PurchaseOrderTransaction.find()
    .populate("items.productId", "name category unit")
    .populate("createdBy", "name")
    .populate("approvedBy", "name");

  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { orderNumber: searchRegex },
      { "supplier.name": searchRegex },
    ]);
  }

  if (status) {
    query = query.where("status").equals(status);
  }

  if (startDate && endDate) {
    query = query.where("orderDate").gte(new Date(startDate)).lte(new Date(endDate));
  }

  const sort = {};
  sort[sortKey] = sortOrder === "desc" ? -1 : 1;
  query = query.sort(sort);

  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  const [orders, total] = await Promise.all([
    query.exec(),
    PurchaseOrderTransaction.countDocuments(query.getFilter()),
  ]);

  const response = generateResponse(
    "Success",
    "Purchase orders fetched successfully",
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

const getPurchaseOrderById = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid purchase order ID format", 400));
  }

  const order = await PurchaseOrderTransaction.findById(id)
    .populate("items.productId", "name category unit costPrice")
    .populate("createdBy", "name")
    .populate("approvedBy", "name");

  if (!order) {
    return next(new AppError("No purchase order found with that ID", 404));
  }

  const response = generateResponse(
    "Success",
    "Purchase order fetched successfully",
    order,
    undefined
  );

  return res.status(200).json(response);
});

const updatePurchaseOrder = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const updateData = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid purchase order ID format", 400));
  }

  const order = await PurchaseOrderTransaction.findById(id);
  if (!order) {
    return next(new AppError("No purchase order found with that ID", 404));
  }

  // Don't allow updates if order is completed or cancelled
  if (order.status === "completed" || order.status === "cancelled") {
    return next(new AppError("Cannot update completed or cancelled order", 400));
  }

  // If updating items, recalculate total amount
  if (updateData.items) {
    let totalAmount = 0;
    for (const item of updateData.items) {
      if (!mongoose.isValidObjectId(item.productId)) {
        return next(new AppError("Invalid product ID format", 400));
      }

      const product = await InventoryProduct.findById(item.productId);
      if (!product) {
        return next(new AppError(`Product not found for ID: ${item.productId}`, 404));
      }

      item.unit = product.unit;
      item.amount = item.quantity * item.rate;
      totalAmount += item.amount;
    }
    updateData.totalAmount = totalAmount;
  }

  const updatedOrder = await PurchaseOrderTransaction.findByIdAndUpdate(id, updateData, {
    new: true,
    runValidators: true,
  }).populate("items.productId", "name category unit");

  const response = generateResponse(
    "Success",
    "Purchase order updated successfully",
    updatedOrder,
    undefined
  );

  return res.status(200).json(response);
});

const approvePurchaseOrder = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid purchase order ID format", 400));
  }

  const order = await PurchaseOrderTransaction.findById(id);
  if (!order) {
    return next(new AppError("No purchase order found with that ID", 404));
  }

  if (order.status !== "pending") {
    return next(new AppError("Only pending orders can be approved", 400));
  }

  const updatedOrder = await PurchaseOrderTransaction.findByIdAndUpdate(
    id,
    {
      status: "approved",
      approvedBy: req.user?.id,
      approvedAt: new Date(),
    },
    { new: true }
  ).populate("items.productId", "name category unit");

  const response = generateResponse(
    "Success",
    "Purchase order approved successfully",
    updatedOrder,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GRN CONTROLLERS ====================

const createGRN = catchAsync(async (req, res, next) => {
  const {
    purchaseOrderId,
    items,
    additionalItems = [],
    invoiceNumber,
    vehicleNumber,
    driverName,
    driverContact,
    notes,
  } = req.body;

  if (!mongoose.isValidObjectId(purchaseOrderId)) {
    return next(new AppError("Invalid purchase order ID format", 400));
  }

  const purchaseOrder = await PurchaseOrderTransaction.findById(purchaseOrderId);
  if (!purchaseOrder) {
    return next(new AppError("Purchase order not found", 404));
  }

  if (purchaseOrder.status === "cancelled") {
    return next(new AppError("Cannot create GRN for cancelled purchase order", 400));
  }

  // Validate and process items
  let totalAmount = 0;
  const updatedPurchaseOrderItems = [];

  for (const item of items) {
    if (!mongoose.isValidObjectId(item.productId)) {
      return next(new AppError("Invalid product ID format", 400));
    }

    const product = await InventoryProduct.findById(item.productId);
    if (!product) {
      return next(new AppError(`Product not found for ID: ${item.productId}`, 404));
    }

    // Find corresponding item in purchase order
    const poItem = purchaseOrder.items.find(poItem => 
      poItem.productId.toString() === item.productId
    );

    if (!poItem) {
      return next(new AppError(`Product ${product.name} not found in purchase order`, 400));
    }

    if (item.receivedQuantity > poItem.remainingQuantity) {
      return next(new AppError(`Received quantity exceeds remaining quantity for ${product.name}`, 400));
    }

    item.unit = product.unit;
    item.rate = poItem.rate;
    item.amount = item.receivedQuantity * item.rate;
    item.orderedQuantity = poItem.quantity;
    totalAmount += item.amount;

    // Update purchase order item
    poItem.receivedQuantity += item.receivedQuantity;
    poItem.remainingQuantity -= item.receivedQuantity;
    updatedPurchaseOrderItems.push(poItem);
  }

  // Process additional items
  for (const item of additionalItems) {
    if (!mongoose.isValidObjectId(item.productId)) {
      return next(new AppError("Invalid product ID format", 400));
    }

    const product = await InventoryProduct.findById(item.productId);
    if (!product) {
      return next(new AppError(`Product not found for ID: ${item.productId}`, 404));
    }

    item.unit = product.unit;
    item.amount = item.quantity * item.rate;
    totalAmount += item.amount;
  }

  // Create GRN
  const grn = await GRNTransaction.create({
    purchaseOrderId,
    supplier: purchaseOrder.supplier,
    items,
    additionalItems,
    totalAmount,
    invoiceNumber,
    vehicleNumber,
    driverName,
    driverContact,
    notes,
    receivedBy: req.user?.id,
  });

  // Update purchase order
  purchaseOrder.items = updatedPurchaseOrderItems;
  
  // Check if all items are fully received
  const allItemsReceived = purchaseOrder.items.every(item => item.remainingQuantity === 0);
  if (allItemsReceived) {
    purchaseOrder.status = "completed";
  } else {
    purchaseOrder.status = "partially_received";
  }

  await purchaseOrder.save();

  // Update inventory for each item
  for (const item of [...items, ...additionalItems]) {
    // Create or update batch
    let batch = null;
    if (item.batchNumber) {
      batch = await InventoryBatch.findOne({
        productId: item.productId,
        batchNumber: item.batchNumber,
      });

      if (!batch) {
        batch = await InventoryBatch.create({
          productId: item.productId,
          batchNumber: item.batchNumber,
          quantity: item.receivedQuantity || item.quantity,
          receivedQuantity: item.receivedQuantity || item.quantity,
          remainingQuantity: item.receivedQuantity || item.quantity,
          costPrice: item.rate,
          supplier: purchaseOrder.supplier,
          manufacturingDate: item.manufacturingDate,
          expiryDate: item.expiryDate,
          receivedBy: req.user?.id,
          notes: item.notes,
        });
      } else {
        batch.receivedQuantity += (item.receivedQuantity || item.quantity);
        batch.remainingQuantity += (item.receivedQuantity || item.quantity);
        await batch.save();
      }
    }

    // Create inward transaction
    await InventoryInward.create({
      productId: item.productId,
      batchId: batch?._id,
      quantity: item.receivedQuantity || item.quantity,
      costPrice: item.rate,
      totalAmount: item.amount,
      supplier: purchaseOrder.supplier,
      invoiceNumber,
      receivedBy: req.user?.id,
      notes: item.notes,
    });

    // Update product stock
    await InventoryProduct.findByIdAndUpdate(item.productId, {
      $inc: { currentStock: item.receivedQuantity || item.quantity },
    });
  }

  const response = generateResponse(
    "Success",
    "GRN created successfully",
    grn,
    undefined
  );

  return res.status(201).json(response);
});

const getAllGRNs = catchAsync(async (req, res, next) => {
  const {
    sortKey = "createdAt",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 10,
    status,
    startDate,
    endDate,
  } = req.query;

  let query = GRNTransaction.find()
    .populate("purchaseOrderId", "orderNumber")
    .populate("items.productId", "name category unit")
    .populate("additionalItems.productId", "name category unit")
    .populate("receivedBy", "name");

  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { grnNumber: searchRegex },
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

  const [grns, total] = await Promise.all([
    query.exec(),
    GRNTransaction.countDocuments(query.getFilter()),
  ]);

  const response = generateResponse(
    "Success",
    "GRNs fetched successfully",
    {
      data: grns,
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

// ==================== PRODUCT DISPATCH CONTROLLERS ====================

const createProductDispatch = catchAsync(async (req, res, next) => {
  const {
    driver,
    vehicle,
    items,
    destination,
    notes,
  } = req.body;

  // Validate items and check stock availability
  for (const item of items) {
    if (!mongoose.isValidObjectId(item.productId)) {
      return next(new AppError("Invalid product ID format", 400));
    }

    const product = await InventoryProduct.findById(item.productId);
    if (!product) {
      return next(new AppError(`Product not found for ID: ${item.productId}`, 404));
    }

    if (product.currentStock < item.quantity) {
      return next(new AppError(`Insufficient stock for ${product.name}. Available: ${product.currentStock}`, 400));
    }
  }

  const dispatch = await ProductDispatch.create({
    driver,
    vehicle,
    items,
    destination,
    notes,
    dispatchedBy: req.user?.id,
  });

  // Update product stock
  for (const item of items) {
    await InventoryProduct.findByIdAndUpdate(item.productId, {
      $inc: { currentStock: -item.quantity },
    });
  }

  const response = generateResponse(
    "Success",
    "Product dispatch created successfully",
    dispatch,
    undefined
  );

  return res.status(201).json(response);
});

const getAllProductDispatches = catchAsync(async (req, res, next) => {
  const {
    sortKey = "createdAt",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 10,
    status,
    startDate,
    endDate,
  } = req.query;

  let query = ProductDispatch.find()
    .populate("items.productId", "name category unit")
    .populate("dispatchedBy", "name");

  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { dispatchNumber: searchRegex },
      { "driver.name": searchRegex },
      { "vehicle.number": searchRegex },
    ]);
  }

  if (status) {
    query = query.where("status").equals(status);
  }

  if (startDate && endDate) {
    query = query.where("dispatchDate").gte(new Date(startDate)).lte(new Date(endDate));
  }

  const sort = {};
  sort[sortKey] = sortOrder === "desc" ? -1 : 1;
  query = query.sort(sort);

  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  const [dispatches, total] = await Promise.all([
    query.exec(),
    ProductDispatch.countDocuments(query.getFilter()),
  ]);

  const response = generateResponse(
    "Success",
    "Product dispatches fetched successfully",
    {
      data: dispatches,
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

// ==================== SELL ORDER CONTROLLERS ====================

const createSellOrder = catchAsync(async (req, res, next) => {
  const {
    farmer,
    items,
    paymentMode,
    paymentDetails,
    paymentScreenshots,
    vehicleDetails,
    notes,
  } = req.body;

  // Validate items and check stock availability
  let totalAmount = 0;
  for (const item of items) {
    if (!mongoose.isValidObjectId(item.productId)) {
      return next(new AppError("Invalid product ID format", 400));
    }

    const product = await InventoryProduct.findById(item.productId);
    if (!product) {
      return next(new AppError(`Product not found for ID: ${item.productId}`, 404));
    }

    if (product.currentStock < item.quantity) {
      return next(new AppError(`Insufficient stock for ${product.name}. Available: ${product.currentStock}`, 400));
    }

    item.unit = product.unit;
    item.amount = item.quantity * item.rate;
    totalAmount += item.amount;
  }

  const sellOrder = await SellOrder.create({
    farmer,
    items,
    totalAmount,
    receivedAmount: 0,
    balanceAmount: totalAmount,
    paymentMode,
    paymentDetails,
    paymentScreenshots,
    vehicleDetails,
    notes,
    createdBy: req.user?.id,
  });

  const response = generateResponse(
    "Success",
    "Sell order created successfully",
    sellOrder,
    undefined
  );

  return res.status(201).json(response);
});

const getAllSellOrders = catchAsync(async (req, res, next) => {
  const {
    sortKey = "createdAt",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 10,
    status,
    startDate,
    endDate,
  } = req.query;

  let query = SellOrder.find()
    .populate("items.productId", "name category unit")
    .populate("createdBy", "name");

  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { orderNumber: searchRegex },
      { "farmer.name": searchRegex },
      { "farmer.mobile": searchRegex },
    ]);
  }

  if (status) {
    query = query.where("status").equals(status);
  }

  if (startDate && endDate) {
    query = query.where("orderDate").gte(new Date(startDate)).lte(new Date(endDate));
  }

  const sort = {};
  sort[sortKey] = sortOrder === "desc" ? -1 : 1;
  query = query.sort(sort);

  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  const [orders, total] = await Promise.all([
    query.exec(),
    SellOrder.countDocuments(query.getFilter()),
  ]);

  const response = generateResponse(
    "Success",
    "Sell orders fetched successfully",
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

const updateSellOrderPayment = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { receivedAmount, paymentMode, paymentDetails, paymentScreenshots } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid sell order ID format", 400));
  }

  const order = await SellOrder.findById(id);
  if (!order) {
    return next(new AppError("No sell order found with that ID", 404));
  }

  if (order.status === "cancelled" || order.status === "delivered") {
    return next(new AppError("Cannot update payment for cancelled or delivered order", 400));
  }

  const newReceivedAmount = (order.receivedAmount || 0) + (receivedAmount || 0);
  
  if (newReceivedAmount > order.totalAmount) {
    return next(new AppError("Received amount cannot exceed total amount", 400));
  }

  const updatedOrder = await SellOrder.findByIdAndUpdate(
    id,
    {
      receivedAmount: newReceivedAmount,
      balanceAmount: order.totalAmount - newReceivedAmount,
      paymentMode,
      paymentDetails,
      paymentScreenshots: [...(order.paymentScreenshots || []), ...(paymentScreenshots || [])],
    },
    { new: true }
  ).populate("items.productId", "name category unit");

  const response = generateResponse(
    "Success",
    "Payment updated successfully",
    updatedOrder,
    undefined
  );

  return res.status(200).json(response);
});

const confirmSellOrder = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid sell order ID format", 400));
  }

  const order = await SellOrder.findById(id);
  if (!order) {
    return next(new AppError("No sell order found with that ID", 404));
  }

  if (order.status !== "pending") {
    return next(new AppError("Only pending orders can be confirmed", 400));
  }

  // Check stock availability again
  for (const item of order.items) {
    const product = await InventoryProduct.findById(item.productId);
    if (product.currentStock < item.quantity) {
      return next(new AppError(`Insufficient stock for ${product.name}. Available: ${product.currentStock}`, 400));
    }
  }

  // Update stock
  for (const item of order.items) {
    await InventoryProduct.findByIdAndUpdate(item.productId, {
      $inc: { currentStock: -item.quantity },
    });
  }

  const updatedOrder = await SellOrder.findByIdAndUpdate(
    id,
    { status: "confirmed" },
    { new: true }
  ).populate("items.productId", "name category unit");

  const response = generateResponse(
    "Success",
    "Sell order confirmed successfully",
    updatedOrder,
    undefined
  );

  return res.status(200).json(response);
});

export {
  // Purchase Order controllers
  createPurchaseOrder,
  getAllPurchaseOrders,
  getPurchaseOrderById,
  updatePurchaseOrder,
  approvePurchaseOrder,
  
  // GRN controllers
  createGRN,
  getAllGRNs,
  
  // Product Dispatch controllers
  createProductDispatch,
  getAllProductDispatches,
  
  // Sell Order controllers
  createSellOrder,
  getAllSellOrders,
  updateSellOrderPayment,
  confirmSellOrder,
};
