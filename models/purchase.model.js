import mongoose from "mongoose";
const { Schema, model } = mongoose;

// Purchase Order Schema
const purchaseOrderSchema = new Schema({
  orderNumber: {
    type: String,
    required: true,
    unique: true,
  },
  supplier: {
    name: {
      type: String,
      required: true,
    },
    contact: String,
    email: String,
    address: String,
    gstNumber: String,
  },
  orderDate: {
    type: Date,
    default: Date.now,
  },
  expectedDeliveryDate: {
    type: Date,
  },
  status: {
    type: String,
    enum: ["pending", "approved", "partially_received", "completed", "cancelled"],
    default: "pending",
  },
  totalAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  items: [{
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    unit: {
      type: String,
      required: true,
    },
    rate: {
      type: Number,
      required: true,
      min: 0,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
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
  }],
  notes: String,
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  approvedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  approvedAt: Date,
}, {
  timestamps: true,
});

// Pre-save middleware to generate order number
purchaseOrderSchema.pre('save', async function(next) {
  if (this.isNew) {
    const count = await this.constructor.countDocuments();
    this.orderNumber = `PO-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
    
    // Calculate remaining quantity for each item
    this.items.forEach(item => {
      item.remainingQuantity = item.quantity;
    });
  }
  next();
});

// GRN (Goods Receipt Note) Schema
const grnSchema = new Schema({
  grnNumber: {
    type: String,
    required: true,
    unique: true,
  },
  purchaseOrderId: {
    type: Schema.Types.ObjectId,
    ref: "PurchaseOrder",
    required: true,
  },
  supplier: {
    name: String,
    contact: String,
    email: String,
    address: String,
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
    enum: ["pending", "completed", "cancelled"],
    default: "pending",
  },
  items: [{
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    orderedQuantity: {
      type: Number,
      required: true,
    },
    receivedQuantity: {
      type: Number,
      required: true,
      min: 0,
    },
    unit: {
      type: String,
      required: true,
    },
    rate: {
      type: Number,
      required: true,
      min: 0,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    batchNumber: String,
    manufacturingDate: Date,
    expiryDate: Date,
    quality: {
      type: String,
      enum: ["excellent", "good", "average", "poor"],
      default: "good",
    },
    notes: String,
  }],
  additionalItems: [{
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    unit: {
      type: String,
      required: true,
    },
    rate: {
      type: Number,
      required: true,
      min: 0,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    batchNumber: String,
    manufacturingDate: Date,
    expiryDate: Date,
    quality: {
      type: String,
      enum: ["excellent", "good", "average", "poor"],
      default: "good",
    },
    notes: String,
  }],
  totalAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  invoiceNumber: String,
  vehicleNumber: String,
  driverName: String,
  driverContact: String,
  notes: String,
}, {
  timestamps: true,
});

// Pre-save middleware to generate GRN number
grnSchema.pre('save', async function(next) {
  if (this.isNew) {
    const count = await this.constructor.countDocuments();
    this.grnNumber = `GRN-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

// Product Dispatch Schema
const productDispatchSchema = new Schema({
  dispatchNumber: {
    type: String,
    required: true,
    unique: true,
  },
  driver: {
    name: {
      type: String,
      required: true,
    },
    contact: {
      type: String,
      required: true,
    },
    licenseNumber: String,
  },
  vehicle: {
    number: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ["truck", "van", "pickup", "other"],
      default: "truck",
    },
  },
  dispatchDate: {
    type: Date,
    default: Date.now,
  },
  status: {
    type: String,
    enum: ["pending", "dispatched", "delivered", "cancelled"],
    default: "pending",
  },
  items: [{
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    unit: String,
    batchNumber: String,
  }],
  destination: {
    address: String,
    city: String,
    state: String,
    pincode: String,
    contactPerson: String,
    contactNumber: String,
  },
  notes: String,
  dispatchedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  deliveredAt: Date,
}, {
  timestamps: true,
});

// Pre-save middleware to generate dispatch number
productDispatchSchema.pre('save', async function(next) {
  if (this.isNew) {
    const count = await this.constructor.countDocuments();
    this.dispatchNumber = `DISP-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

// Sell Order Schema
const sellOrderSchema = new Schema({
  orderNumber: {
    type: String,
    required: true,
    unique: true,
  },
  farmer: {
    name: {
      type: String,
      required: true,
    },
    mobile: {
      type: String,
      required: true,
    },
    district: {
      type: String,
      required: true,
    },
    village: {
      type: String,
      required: true,
    },
    taluka: {
      type: String,
      required: true,
    },
    address: String,
  },
  orderDate: {
    type: Date,
    default: Date.now,
  },
  status: {
    type: String,
    enum: ["pending", "confirmed", "processing", "dispatched", "delivered", "cancelled"],
    default: "pending",
  },
  items: [{
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    unit: String,
    size: String,
    rate: {
      type: Number,
      required: true,
      min: 0,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
  }],
  totalAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  receivedAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  balanceAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  paymentMode: {
    type: String,
    enum: ["cash", "cheque", "bank_transfer", "upi", "card", "other"],
    required: true,
  },
  paymentDetails: {
    transactionId: String,
    bankName: String,
    chequeNumber: String,
    upiId: String,
    cardLastFour: String,
  },
  paymentScreenshots: [String], // Array of image URLs
  vehicleDetails: {
    number: String,
    type: String,
    driverName: String,
    driverContact: String,
  },
  notes: String,
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  deliveredAt: Date,
  deliveryProof: [String], // Array of delivery proof image URLs
}, {
  timestamps: true,
});

// Pre-save middleware to generate order number and calculate amounts
sellOrderSchema.pre('save', async function(next) {
  if (this.isNew) {
    const count = await this.constructor.countDocuments();
    this.orderNumber = `SO-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
  }
  
  // Calculate total amount
  this.totalAmount = this.items.reduce((total, item) => total + item.amount, 0);
  
  // Calculate balance amount
  this.balanceAmount = this.totalAmount - this.receivedAmount;
  
  next();
});

// Create models - check if they exist first to avoid overwrite errors
const PurchaseOrderTransaction = mongoose.models.PurchaseOrderTransaction || model("PurchaseOrderTransaction", purchaseOrderSchema);
const GRNTransaction = mongoose.models.GRNTransaction || model("GRNTransaction", grnSchema);
const ProductDispatch = mongoose.models.ProductDispatch || model("ProductDispatch", productDispatchSchema);
const SellOrder = mongoose.models.SellOrder || model("SellOrder", sellOrderSchema);

export { PurchaseOrderTransaction, GRNTransaction, ProductDispatch, SellOrder };
