import mongoose, { Schema, model } from "mongoose";

// Define a schema for delivery change history
const deliveryChangeSchema = new Schema(
  {
    previousDeliveryDate: {
      startDay: String,
      endDay: String,
      month: String,
      year: Number,
    },
    newDeliveryDate: {
      startDay: String,
      endDay: String,
      month: String,
      year: Number,
    },
    previousSlot: {
      type: Schema.Types.ObjectId,
      ref: "PlantSlot.subtypeSlots",
    },
    newSlot: {
      type: Schema.Types.ObjectId,
      ref: "PlantSlot.subtypeSlots",
    },
    reasonForChange: {
      type: String,
      required: true,
    },
    changedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    //  required: true,
    },
  },
  { timestamps: true }
);

// Define a schema for status change history
const statusChangeSchema = new Schema(
  {
    previousStatus: {
      type: String,
      enum: [
        "PENDING",
        "PROCESSING",
        "COMPLETED",
        "CANCELLED",
        "DISPATCHED",
        "ACCEPTED",
        "REJECTED",
        "FARM_READY",
        "DISPATCH_PROCESS",
      ],
      required: true,
    },
    newStatus: {
      type: String,
      enum: [
        "PENDING",
        "PROCESSING",
        "COMPLETED",
        "CANCELLED",
        "DISPATCHED",
        "ACCEPTED",
        "REJECTED",
        "FARM_READY",
        "DISPATCH_PROCESS",
      ],
      required: true,
    },
    reason: {
      type: String,
    },
    changedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    notes: {
      type: String,
    },
  },
  { timestamps: true }
);

const paymentSchema = new Schema(
  {
    paidAmount: {
      type: Number,
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ["COLLECTED", "REJECTED", "PENDING"],
      default: "PENDING",
    },
    paymentDate: {
      type: Date,
      required: true,
    },
    bankName: {
      type: String,
    },
    receiptPhoto: [
      {
        type: String, // Store URLs (strings) for uploaded files
      },
    ],
    modeOfPayment: {
      type: String,
      required: true,
    },
    remark: {
      type: String,
    },
    isWalletPayment:{
      type: Boolean,
      default: false,
    }
  },
  { timestamps: true }
);

const orderSchema = new Schema(
  {
    orderId: {
      type: Number,
      unique: true,
      required: true,
    },
    dealerOrder: {
      type: Boolean,
      default: false,
    },
    farmer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Farmer",
      required: function() {
        return !this.dealerOrder; // Required only if not a dealer order
      }
    },
    dealer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: function() {
        return this.dealerOrder; // Required only if it is a dealer order
      }
    },
    salesPerson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    numberOfPlants: {
      type: Number,
      required: true,
    },
    // Field to track remaining plants (initially equals numberOfPlants)
    remainingPlants: {
      type: Number,
      default: function() {
        return this.numberOfPlants;
      }
    },
    plantName: {
      type: Schema.Types.ObjectId,
      ref: "PlantCms",
      required: true,
    },
    plantSubtype: {
      type: Schema.Types.ObjectId,
      ref: "PlantCms.subtypes",
      required: true,
    },
    bookingSlot: {
      type: Schema.Types.ObjectId,
      ref: "PlantSlot.subtypeSlots",
      required: true,
    },
    cavity: {
      type: Schema.Types.ObjectId,
      ref: "Tray",
     // required: true,
    },
    rate: {
      type: Number,
      required: true,
    },
    orderPaymentStatus: {
      type: String,
      enum: ["PENDING", "COMPLETED"],
      default: "PENDING",
    },
    payment: [paymentSchema],
    notes: {
      type: String,
    },
    // Changed to array of strings for order remarks
    orderRemarks: [String],
    orderStatus: {
      type: String,
      enum: [
        "PENDING",
        "PROCESSING",
        "COMPLETED",
        "CANCELLED",
        "DISPATCHED",
        "ACCEPTED",
        "REJECTED",
        "FARM_READY",
        "DISPATCH_PROCESS",
      ],
      default: "PENDING",
    },
    // Field to track status change history
    statusChanges: [statusChangeSchema],
    paymentCompleted: {
      type: Boolean,
      default: false,
    },
    farmReadyDate: {
      type: Date,
    },
    returnedPlants: {
      type: Number,
      default: 0,
    },
    returnReason: {
      type: String,
    },
    // Field to track delivery changes history
    deliveryChanges: [deliveryChangeSchema],
    // Field to track return history
    returnHistory: [{
      date: {
        type: Date,
        default: Date.now,
      },
      quantity: {
        type: Number,
        required: true,
      },
      reason: {
        type: String,
      },
      dispatchId: {
        type: Schema.Types.ObjectId,
        ref: "Dispatch",
      },
      processedBy: {
        type: Schema.Types.ObjectId,
        ref: "User",
      }
    }],
  },
  { timestamps: true }
);

// Indexes
orderSchema.index({ farmer: 1 });
orderSchema.index({ dealer: 1 });
orderSchema.index({ salesPerson: 1 });
orderSchema.index({ plantName: 1 });
orderSchema.index({ bookingSlot: 1 });
orderSchema.index({ orderStatus: 1 });
orderSchema.index({ createdAt: 1 });
orderSchema.index({ orderPaymentStatus: 1 });
orderSchema.index({ createdAt: 1, orderStatus: 1 });
orderSchema.index({ cavity: 1 }); // Added index for cavity field
orderSchema.index({ returnedPlants: 1 }); // Added index for returnedPlants
orderSchema.index({ remainingPlants: 1 }); // Added index for remainingPlants

// Pre-save middleware to generate unique orderId
orderSchema.pre("save", async function (next) {
  if (!this.isNew || this.orderId) return next();

  try {
    const maxOrder = await this.constructor
      .findOne()
      .sort({ orderId: -1 })
      .select("orderId");
    this.orderId = maxOrder ? maxOrder.orderId + 1 : 1;
    next();
  } catch (err) {
    next(err);
  }
});

// Pre-save middleware to calculate orderPaymentStatus based on paymentStatus "COLLECTED"
orderSchema.pre("save", function (next) {
  // Filter payments with paymentStatus "COLLECTED"
  const totalCollected = this.payment
    .filter((p) => p.paymentStatus === "COLLECTED")
    .reduce((sum, p) => sum + (p.paidAmount || 0), 0);

  const totalAmount = this.rate * this.numberOfPlants;

  // Update orderPaymentStatus and paymentCompleted
  this.orderPaymentStatus =
    totalCollected >= totalAmount ? "COMPLETED" : "PENDING";
  this.paymentCompleted = totalCollected >= totalAmount;

  next();
});

// Pre-save middleware to update remainingPlants when returnedPlants changes
orderSchema.pre("save", function (next) {
  // If returnedPlants has changed
  if (this.isModified('returnedPlants')) {
    // Calculate remaining plants
    this.remainingPlants = Math.max(0, this.numberOfPlants - this.returnedPlants);
    
    // Check if this is a new return (not just a modification of an existing return)
    const returnEntry = this.returnHistory?.find(
      entry => entry.quantity === this.returnedPlants - (this._oldReturnedPlants || 0)
    );
    
    // If no matching entry found and there was an actual return (not just setting to 0)
    if (!returnEntry && this.returnedPlants > (this._oldReturnedPlants || 0)) {
      // Add a new return history entry
      if (!this.returnHistory) {
        this.returnHistory = [];
      }
      
      this.returnHistory.push({
        date: new Date(),
        quantity: this.returnedPlants - (this._oldReturnedPlants || 0),
        reason: this.returnReason
      });
    }
    
    // Store the current value for next comparison
    this._oldReturnedPlants = this.returnedPlants;
  }
  
  next();
});

// Pre-save middleware to track orderStatus changes
orderSchema.pre("save", function (next) {
  // Check if orderStatus has changed and it's not a new document
  if (this.isModified('orderStatus') && !this.isNew) {
    // Get the previous status (before this update)
    const previousStatus = this._oldOrderStatus || this.constructor.schema.paths.orderStatus.default;
    const newStatus = this.orderStatus;
    
    // Don't create a history entry if status hasn't actually changed
    if (previousStatus !== newStatus) {
      // Initialize statusChanges array if it doesn't exist yet
      if (!this.statusChanges) {
        this.statusChanges = [];
      }
      
      // Add new status change record
      this.statusChanges.push({
        previousStatus: previousStatus,
        newStatus: newStatus,
        // reason and changedBy would typically be set by the controller that's changing the status
        // We'll just record the status change with available information
      });
    }
    
    // Store current status for future comparisons
    this._oldOrderStatus = this.orderStatus;
  } else if (this.isNew) {
    // Store initial status for new documents
    this._oldOrderStatus = this.orderStatus;
  }
  
  next();
});

// Add validation middleware to ensure proper business logic
orderSchema.pre('validate', function(next) {
  // Ensure returnedPlants doesn't exceed numberOfPlants
  if (this.returnedPlants > this.numberOfPlants) {
    const error = new Error('Returned plants cannot exceed the total number of plants in the order');
    return next(error);
  }
  next();
});

const Order = model("Order", orderSchema);

export default Order;