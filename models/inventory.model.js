import { Schema, model } from "mongoose";

// Product Schema
const productSchema = new Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    trim: true,
  },
  category: {
    type: String,
    required: true,
    enum: ["Seeds", "Fertilizers", "Chemicals", "Tools", "Equipment", "Pots", "Soil", "Other"],
  },
  unit: {
    type: String,
    required: true,
    enum: ["kg", "g", "l", "ml", "pieces", "packets", "bottles", "bags"],
  },
  minStockLevel: {
    type: Number,
    default: 0,
    min: 0,
  },
  maxStockLevel: {
    type: Number,
    min: 0,
  },
  currentStock: {
    type: Number,
    default: 0,
    min: 0,
  },
  costPrice: {
    type: Number,
    required: true,
    min: 0,
  },
  sellingPrice: {
    type: Number,
    min: 0,
  },
  supplier: {
    name: String,
    contact: String,
    email: String,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  image: {
    type: String,
  },
  tags: [String],
}, {
  timestamps: true,
});

// Batch Schema for inventory items
const inventoryBatchSchema = new Schema({
  productId: {
    type: Schema.Types.ObjectId,
    ref: "InventoryProduct",
    required: true,
  },
  batchNumber: {
    type: String,
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
  },
  receivedQuantity: {
    type: Number,
    default: 0,
    min: 0,
  },
  remainingQuantity: {
    type: Number,
    min: 0,
  },
  manufacturingDate: {
    type: Date,
  },
  expiryDate: {
    type: Date,
  },
  costPrice: {
    type: Number,
    required: true,
    min: 0,
  },
  supplier: {
    name: String,
    contact: String,
    email: String,
  },
  receivedDate: {
    type: Date,
    default: Date.now,
  },
  receivedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  status: {
    type: String,
    enum: ["active", "expired", "depleted"],
    default: "active",
  },
  notes: String,
}, {
  timestamps: true,
});

// Inventory Inward Schema
const inventoryInwardSchema = new Schema({
  productId: {
    type: Schema.Types.ObjectId,
    ref: "InventoryProduct",
    required: true,
  },
  batchId: {
    type: Schema.Types.ObjectId,
    ref: "InventoryBatch",
    required: false, // Made optional
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
  },
  costPrice: {
    type: Number,
    required: true,
    min: 0,
  },
  totalAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  supplier: {
    name: String,
    contact: String,
    email: String,
  },
  invoiceNumber: String,
  receivedDate: {
    type: Date,
    default: Date.now,
  },
  receivedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  notes: String,
  status: {
    type: String,
    enum: ["pending", "received", "cancelled"],
    default: "received",
  },
}, {
  timestamps: true,
});

// Inventory Outward Schema
const inventoryOutwardSchema = new Schema({
  productId: {
    type: Schema.Types.ObjectId,
    ref: "InventoryProduct",
    required: true,
  },
  batchId: {
    type: Schema.Types.ObjectId,
    ref: "InventoryBatch",
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
  },
  sellingPrice: {
    type: Number,
    min: 0,
  },
  totalAmount: {
    type: Number,
    min: 0,
  },
  customer: {
    name: String,
    contact: String,
    email: String,
  },
  purpose: {
    type: String,
    enum: ["sale", "internal_use", "damaged", "expired", "transfer", "other"],
    required: true,
  },
  destination: {
    type: String,
    enum: ["customer", "internal", "disposal", "transfer"],
    required: true,
  },
  outwardDate: {
    type: Date,
    default: Date.now,
  },
  issuedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  notes: String,
  status: {
    type: String,
    enum: ["pending", "issued", "cancelled"],
    default: "issued",
  },
}, {
  timestamps: true,
});

// Stock Adjustment Schema
const stockAdjustmentSchema = new Schema({
  productId: {
    type: Schema.Types.ObjectId,
    ref: "InventoryProduct",
    required: true,
  },
  batchId: {
    type: Schema.Types.ObjectId,
    ref: "InventoryBatch",
  },
  adjustmentType: {
    type: String,
    enum: ["addition", "subtraction", "correction"],
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
  },
  reason: {
    type: String,
    required: true,
    enum: ["damage", "expiry", "theft", "counting_error", "quality_issue", "other"],
  },
  adjustedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  adjustmentDate: {
    type: Date,
    default: Date.now,
  },
  notes: String,
}, {
  timestamps: true,
});

// Create models
const InventoryProduct = model("InventoryProduct", productSchema);
const InventoryBatch = model("InventoryBatch", inventoryBatchSchema);
const InventoryInward = model("InventoryInward", inventoryInwardSchema);
const InventoryOutwardTransaction = model("InventoryOutwardTransaction", inventoryOutwardSchema);
const StockAdjustment = model("StockAdjustment", stockAdjustmentSchema);

export { InventoryProduct, InventoryBatch, InventoryInward, InventoryOutwardTransaction, StockAdjustment }; 