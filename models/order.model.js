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
      // Note: This references a subdocument within PlantSlot, cannot use .populate()
      // Use aggregation or manual lookup instead
    },
    newSlot: {
      type: Schema.Types.ObjectId,
      // Note: This references a subdocument within PlantSlot, cannot use .populate()
      // Use aggregation or manual lookup instead
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
        "READY_FOR_DISPATCH",
        "DISPATCH_PROCESS",
        "PARTIALLY_COMPLETED",
        "TEMPORARY_CANCELLED",
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
        "READY_FOR_DISPATCH",
        "DISPATCH_PROCESS",
        "PARTIALLY_COMPLETED",
        "TEMPORARY_CANCELLED",
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

// Define a schema for farm ready date change history
const farmReadyDateChangeSchema = new Schema(
  {
    previousDate: {
      type: Date,
    },
    newDate: {
      type: Date,
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

// Define a schema for general order edit history
const orderEditHistorySchema = new Schema(
  {
    field: {
      type: String,
      required: true,
      // Field that was changed (e.g., 'rate', 'numberOfPlants', 'deliveryDate')
    },
    previousValue: {
      type: Schema.Types.Mixed,
      // Store the old value (can be any type)
    },
    newValue: {
      type: Schema.Types.Mixed,
      required: true,
      // Store the new value (can be any type)
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

const additionalPlantsHistorySchema = new Schema(
  {
    previousTotal: {
      type: Number,
      required: true,
    },
    newTotal: {
      type: Number,
      required: true,
    },
    changeInPlants: {
      type: Number,
      required: true,
    },
    reason: {
      type: String,
    },
    notes: {
      type: String,
    },
    changedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
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
      enum: ["COLLECTED", "REJECTED", "PENDING", "BANK_VERIFIED"],
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
        type: String, // Store Cloudinary URLs (strings) for uploaded files
      },
    ],
    modeOfPayment: {
      type: String,
      required: function() {
        return !this.isWalletPayment; // Only required if not a wallet payment
      },
    },
    remark: {
      type: String,
    },
    chequeNumber: {
      type: String,
    },
    transactionId: {
      type: String,
      trim: true,
    },
    isWalletPayment: {
      type: Boolean,
      default: false,
    },
    mainPaymentId: {
      type: Schema.Types.ObjectId,
      ref: "BulkPayment",
      default: null,
    },
    qrReferenceId: { type: String, trim: true },
    qrExpiresAt: { type: Date },
    qrImage: { type: String },
    qrPayload: { type: String },
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
      required: function () {
        return !this.dealerOrder; // Required only if not a dealer order
      },
    },
    dealer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: function () {
        return this.dealerOrder; // Required only if it is a dealer order
      },
    },
    salesPerson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Quota management fields for dealer orders
    quotaUsed: {
      type: Number,
      default: 0,
      // Number of plants used from dealer quota
    },
    quotaRestored: {
      type: Boolean,
      default: false,
      // Track if quota was restored when order was rejected
    },
    quotaSource: {
      type: String,
      enum: ["dealer", "company", "none"],
      default: "none",
      // Track where the quota came from
    },
    originalQuotaAllocation: {
      fromWallet: { type: Number, default: 0 },
      fromSlot: { type: Number, default: 0 },
      // Store original quota allocation for restoration
    },
    walletEntryId: {
      type: Schema.Types.ObjectId,
      // Reference to the DealerWallet entry this order uses
      // Used to link orders to specific quota allocations
    },
    numberOfPlants: {
      type: Number,
      required: true,
    },
    additionalPlants: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalPlants: {
      type: Number,
      default: function () {
        return (this.numberOfPlants || 0) + (this.additionalPlants || 0);
      },
    },
    // Field to track remaining plants (initially equals totalPlants)
    remainingPlants: {
      type: Number,
      default: function () {
        const basePlants = (this.numberOfPlants || 0) + (this.additionalPlants || 0);
        return basePlants;
      },
    },
    // Reference to current dispatch (latest dispatch ID)
    currentDispatchId: {
      type: Schema.Types.ObjectId,
      ref: "Dispatch",
    },
    plantName: {
      type: Schema.Types.ObjectId,
      ref: "PlantCms",
      required: true,
    },
    plantSubtype: {
      type: Schema.Types.ObjectId,
      // Note: This references a subdocument within PlantCms, cannot use .populate()
      // Use aggregation or manual lookup instead
      required: true,
    },
    bookingSlot: {
      type: Schema.Types.ObjectId,
      // Note: This references a subdocument within PlantSlot, cannot use .populate()
      // Use aggregation or manual lookup instead
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
    // Screenshots uploaded with the order (Cloudinary URLs)
    screenshots: [String], // Array of Cloudinary image URLs
    // Ready plants product fields - for products from other nurseries
    productName: {
      type: String,
      // Reference name for plant products (e.g., "Ghatude") - independent of actual product
    },
    productMappingId: {
      type: Schema.Types.ObjectId,
      ref: 'PlantProductMapping',
      // Reference to PlantProductMapping for ready plants products
    },
    // Snapshot of product order details at order time - for future reference (not linked)
    productOrderSnapshot: {
      productName: { type: String },
      productMappingId: { type: Schema.Types.ObjectId },
      displayTitle: { type: String },
      productId: { type: Schema.Types.ObjectId },
      dateRange: {
        startDate: { type: String },
        endDate: { type: String },
      },
    },
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
        "READY_FOR_DISPATCH",
        "DISPATCH_PROCESS",
        "PARTIALLY_COMPLETED",
        "TEMPORARY_CANCELLED",
      ],
      default: "PENDING",
    },
    // Field to track status change history
    statusChanges: [statusChangeSchema],
    paymentCompleted: {
      type: Boolean,
      default: false,
    },
    orderBookingDate: {
      type: Date,
    },
    deliveryDate: {
      type: Date,
      required: false, // Optional to allow undated orders (assigned to dummy slot)
      // The specific date selected by user for plant delivery
      // null for undated orders that are assigned to dummy slot
    },
    farmReadyDate: {
      type: Date,
    },
    // Field to track farm ready date changes history
    farmReadyDateChanges: [farmReadyDateChangeSchema],
    additionalPlantsHistory: [additionalPlantsHistorySchema],
    returnedPlants: {
      type: Number,
      default: 0,
    },
    returnReason: {
      type: String,
    },
    // Field to track delivery changes history
    deliveryChanges: [deliveryChangeSchema],
    // Field to track general order edits (rate, quantity, deliveryDate, etc.)
    orderEditHistory: [orderEditHistorySchema],
    // Field to track return history
    returnHistory: [
      {
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
        },
      },
    ],
    // Field to track dispatch history for partial/split orders
    dispatchHistory: [
      {
        date: {
          type: Date,
          default: Date.now,
        },
        quantity: {
          type: Number,
          required: true,
        },
        dispatchId: {
          type: Schema.Types.ObjectId,
          ref: "Dispatch",
        },
        remainingAfterDispatch: {
          type: Number,
          required: true,
        },
        processedBy: {
          type: Schema.Types.ObjectId,
          ref: "User",
        },
        driverName: {
          type: String,
        },
        vehicleName: {
          type: String,
        },
      },
    ],
    // Order for field - optional field with address and mobile number
    orderFor: {
      name: {
        type: String,
      },
      address: {
        type: String,
      },
      mobileNumber: {
        type: Number,
      },
    },
    // Expected nursery field - for tracking expected nursery source
    expectedNursery: {
      type: String,
    },
    // Reference field - reference to user/employee
    reference: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    // Old delivery date - for tracking delivery date changes
    oldDeliveryDate: {
      type: Date,
    },
    // Field to track call history for dispatch managers
    callHistory: [
      {
        date: {
          type: Date,
          default: Date.now,
        },
        calledBy: {
          type: Schema.Types.ObjectId,
          ref: "User",
        },
        note: {
          type: String,
          default: "",
        },
      },
    ],
    // Driver assignment for dispatch routes
    assignedDriver: {
      type: Schema.Types.ObjectId,
      ref: "User",
      // Reference to the driver assigned to deliver this order
    },
    assignedVehicle: {
      type: String,
      // Vehicle number or identifier
    },
    routeId: {
      type: String,
      // Route identifier to group orders in the same delivery route
    },
    routeSequence: {
      type: Number,
      // Sequence number in the route (1, 2, 3, etc.)
    },
    assignedAt: {
      type: Date,
      // When the order was assigned to a route
    },
    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      // User who assigned the order to the route
    },
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
// Compound indexes for optimized slot queries
orderSchema.index({ bookingSlot: 1, orderStatus: 1 }); // For filtering orders by slot and status
orderSchema.index({ bookingSlot: 1, orderStatus: 1, quotaSource: 1 }); // For populateSlotsWithOrders query
orderSchema.index({ cavity: 1 }); // Added index for cavity field
orderSchema.index({ returnedPlants: 1 }); // Added index for returnedPlants
orderSchema.index({ remainingPlants: 1 }); // Added index for remainingPlants
orderSchema.index({ additionalPlants: 1 }); // Added index for additionalPlants
orderSchema.index({ totalPlants: 1 }); // Added index for totalPlants

orderSchema.methods.setAdditionalPlantsChangeMeta = function (meta = {}) {
  this._additionalPlantsChangeMeta = {
    reason: meta?.reason,
    notes: meta?.notes,
    changedBy: meta?.changedBy,
  };
  return this;
};

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

  const totalOrderedPlants =
    (this.numberOfPlants || 0) + (this.additionalPlants || 0);
  const totalAmount = this.rate * totalOrderedPlants;

  // Update orderPaymentStatus and paymentCompleted
  this.orderPaymentStatus =
    totalCollected >= totalAmount ? "COMPLETED" : "PENDING";
  this.paymentCompleted = totalCollected >= totalAmount;

  next();
});

// Pre-save middleware to update remainingPlants when returnedPlants changes
orderSchema.pre("save", function (next) {
  const totalOrderedPlants =
    (this.numberOfPlants || 0) + (this.additionalPlants || 0);

  this.totalPlants = totalOrderedPlants;

  const shouldRecalculateRemaining =
    this.isModified("returnedPlants") ||
    this.isModified("numberOfPlants") ||
    this.isModified("additionalPlants") ||
    typeof this.remainingPlants === "undefined";

  if (shouldRecalculateRemaining) {
    const remaining = Math.max(
      0,
      totalOrderedPlants - (this.returnedPlants || 0)
    );
    this.remainingPlants = remaining;
  }

  if (!this.isNew && this.isModified("additionalPlants")) {
    const previousTotal =
      typeof this._oldAdditionalPlants === "number"
        ? this._oldAdditionalPlants
        : this._originalAdditionalPlants ?? 0;
    const newTotal = this.additionalPlants || 0;

    if (previousTotal !== newTotal) {
      if (!this.additionalPlantsHistory) {
        this.additionalPlantsHistory = [];
      }

      const changeMeta =
        this._additionalPlantsChangeMeta || {
          reason: this.additionalPlantsChangeReason,
          notes: this.additionalPlantsChangeNotes,
          changedBy: this.additionalPlantsChangedBy,
        };

      const historyEntry = {
        previousTotal,
        newTotal,
        changeInPlants: newTotal - previousTotal,
      };

      if (changeMeta?.reason) {
        historyEntry.reason = changeMeta.reason;
      }
      if (changeMeta?.notes) {
        historyEntry.notes = changeMeta.notes;
      }
      if (changeMeta?.changedBy) {
        historyEntry.changedBy = changeMeta.changedBy;
      }

      this.additionalPlantsHistory.push(historyEntry);

      if (!this.orderEditHistory) {
        this.orderEditHistory = [];
      }

      const editHistoryEntry = {
        field: "additionalPlants",
        previousValue: previousTotal,
        newValue: newTotal,
      };

      if (historyEntry.notes) {
        editHistoryEntry.notes = historyEntry.notes;
      }
      if (historyEntry.changedBy) {
        editHistoryEntry.changedBy = historyEntry.changedBy;
      }

      this.orderEditHistory.push(editHistoryEntry);
    }
  }

  if (this.isModified("returnedPlants")) {
    const previousReturned = this._oldReturnedPlants || 0;
    const delta = (this.returnedPlants || 0) - previousReturned;

    if (delta > 0) {
      if (!this.returnHistory) {
        this.returnHistory = [];
      }

      this.returnHistory.push({
        date: new Date(),
        quantity: delta,
        reason: this.returnReason,
      });
    }

    this._oldReturnedPlants = this.returnedPlants || 0;
  }

  this._oldAdditionalPlants = this.additionalPlants || 0;
  if (typeof this._originalAdditionalPlants !== "number") {
    this._originalAdditionalPlants = this.additionalPlants || 0;
  }
  if (typeof this._oldReturnedPlants !== "number") {
    this._oldReturnedPlants = this.returnedPlants || 0;
  }
  this._additionalPlantsChangeMeta = undefined;
  this.additionalPlantsChangeReason = undefined;
  this.additionalPlantsChangeNotes = undefined;
  this.additionalPlantsChangedBy = undefined;

  next();
});

orderSchema.pre("findOneAndUpdate", async function (next) {
  this.setOptions({ new: true, runValidators: true });

  const update = this.getUpdate() || {};
  const $set = { ...(update.$set || {}) };
  const $unset = update.$unset ? { ...update.$unset } : undefined;
  const meta = {};

  const collectMeta = (source) => {
    if (!source) return;
    if (source.additionalPlantsChangeMeta) {
      Object.assign(meta, source.additionalPlantsChangeMeta);
      delete source.additionalPlantsChangeMeta;
    }
    if (source.additionalPlantsChangeReason !== undefined) {
      meta.reason = source.additionalPlantsChangeReason;
      delete source.additionalPlantsChangeReason;
    }
    if (source.additionalPlantsChangeNotes !== undefined) {
      meta.notes = source.additionalPlantsChangeNotes;
      delete source.additionalPlantsChangeNotes;
    }
    if (source.additionalPlantsChangedBy !== undefined) {
      meta.changedBy = source.additionalPlantsChangedBy;
      delete source.additionalPlantsChangedBy;
    }
  };

  collectMeta(update);
  collectMeta($set);

  const relevantKeys = ["numberOfPlants", "additionalPlants", "returnedPlants"];
  relevantKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(update, key)) {
      $set[key] = update[key];
      delete update[key];
    }
  });

  const modifiesQuantity = relevantKeys.some((key) =>
    Object.prototype.hasOwnProperty.call($set, key)
  );

  if (!modifiesQuantity) {
    update.$set = $set;
    if ($unset) {
      const unsetKeys = Object.keys($unset);
      if (unsetKeys.length) {
        update.$unset = $unset;
      } else {
        delete update.$unset;
      }
    }
    this.setUpdate(update);
    return next();
  }

  let doc = null;
  try {
    doc = await this.model
      .findOne(this.getQuery())
      .select("numberOfPlants additionalPlants returnedPlants")
      .lean();
  } catch (error) {
    return next(error);
  }

  const previous = {
    numberOfPlants: doc?.numberOfPlants ?? 0,
    additionalPlants: doc?.additionalPlants ?? 0,
    returnedPlants: doc?.returnedPlants ?? 0,
  };

  const numberOfPlants =
    $set.numberOfPlants ?? previous.numberOfPlants;
  const additionalPlants =
    $set.additionalPlants ?? previous.additionalPlants;
  const returnedPlants =
    $set.returnedPlants ?? previous.returnedPlants;

  const totalPlants = numberOfPlants + additionalPlants;
  const remainingPlants = Math.max(0, totalPlants - returnedPlants);

  $set.totalPlants = totalPlants;
  $set.remainingPlants = remainingPlants;

  if (
    doc &&
    Object.prototype.hasOwnProperty.call($set, "additionalPlants") &&
    additionalPlants !== previous.additionalPlants
  ) {
    const change = additionalPlants - previous.additionalPlants;

    if (change !== 0) {
      update.$push = update.$push || {};

      const historyEntry = {
        previousTotal: previous.additionalPlants,
        newTotal: additionalPlants,
        changeInPlants: change,
      };

      if (meta.reason) historyEntry.reason = meta.reason;
      if (meta.notes) historyEntry.notes = meta.notes;
      if (meta.changedBy) historyEntry.changedBy = meta.changedBy;

      if (update.$push.additionalPlantsHistory) {
        if (update.$push.additionalPlantsHistory.$each) {
          update.$push.additionalPlantsHistory.$each.push(historyEntry);
        } else {
          update.$push.additionalPlantsHistory = {
            $each: [update.$push.additionalPlantsHistory, historyEntry],
          };
        }
      } else {
        update.$push.additionalPlantsHistory = { $each: [historyEntry] };
      }

      const editHistoryEntry = {
        field: "additionalPlants",
        previousValue: previous.additionalPlants,
        newValue: additionalPlants,
      };

      if (historyEntry.notes) editHistoryEntry.notes = historyEntry.notes;
      if (historyEntry.changedBy)
        editHistoryEntry.changedBy = historyEntry.changedBy;

      if (update.$push.orderEditHistory) {
        if (update.$push.orderEditHistory.$each) {
          update.$push.orderEditHistory.$each.push(editHistoryEntry);
        } else {
          update.$push.orderEditHistory = {
            $each: [update.$push.orderEditHistory, editHistoryEntry],
          };
        }
      } else {
        update.$push.orderEditHistory = { $each: [editHistoryEntry] };
      }
    }
  }

  update.$set = $set;

  if ($unset) {
    const unsetKeys = Object.keys($unset);
    if (unsetKeys.length) {
      update.$unset = $unset;
    } else {
      delete update.$unset;
    }
  }

  this.setUpdate(update);
  next();
});

// Pre-save middleware to track orderStatus changes
orderSchema.pre("save", function (next) {
  // Check if orderStatus has changed and it's not a new document
  if (this.isModified("orderStatus") && !this.isNew) {
    // Get the previous status (before this update)
    const previousStatus =
      this._oldOrderStatus || this.constructor.schema.paths.orderStatus.default;
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

// Note: Farm ready date changes are tracked in the controller using $push
// to ensure proper user information and reason tracking

// Add validation middleware to ensure proper business logic
orderSchema.pre("validate", function (next) {
  const totalOrderedPlants =
    (this.numberOfPlants || 0) + (this.additionalPlants || 0);

  if (this.additionalPlants < 0) {
    const error = new Error("Additional plants cannot be negative");
    return next(error);
  }

  // Ensure returnedPlants doesn't exceed total ordered plants
  if (this.returnedPlants > totalOrderedPlants) {
    const error = new Error(
      "Returned plants cannot exceed the total number of plants in the order"
    );
    return next(error);
  }
  next();
});

// Track original values when document is loaded from database
orderSchema.post("init", function() {
  this._originalOrderStatus = this.orderStatus;
  this._originalAdditionalPlants = this.additionalPlants || 0;
  this._oldAdditionalPlants = this.additionalPlants || 0;
  this._oldReturnedPlants = this.returnedPlants || 0;
});

// Pre-save: Check if status changed and store the change
orderSchema.pre("save", function (next) {
  if (!this.isNew && this.isModified("orderStatus")) {
    this._statusChanged = {
      oldStatus: this._originalOrderStatus || "UNKNOWN",
      newStatus: this.orderStatus,
    };
  }
  next();
});

// Post-save: Send notification after status change is committed
orderSchema.post("save", async function (doc) {
  if (doc._statusChanged) {
    // Use setImmediate to avoid blocking the response
    setImmediate(async () => {
      try {
        // Dynamically import to avoid circular dependency
        const { sendStatusChangeNotification } = await import("../utility/orderNotificationHelper.js");
        await sendStatusChangeNotification(doc, doc._statusChanged.oldStatus, doc._statusChanged.newStatus);
      } catch (error) {
        console.error("❌ Error sending status change notification:", error);
        // Don't fail the save if notification fails
      }
    });
  }
});

// Also handle findOneAndUpdate which is used by the controller
orderSchema.post("findOneAndUpdate", async function(doc) {
  if (doc) {
    // Get the update operation
    const update = this.getUpdate();
    const newStatus = update.$set?.orderStatus || update.orderStatus;
    
    if (newStatus && doc.orderStatus !== newStatus) {
      setImmediate(async () => {
        try {
          const { sendStatusChangeNotification } = await import("../utility/orderNotificationHelper.js");
          // Reload the document to get the updated status
          const updatedDoc = await doc.constructor.findById(doc._id);
          if (updatedDoc) {
            await sendStatusChangeNotification(updatedDoc, doc.orderStatus, newStatus);
          }
        } catch (error) {
          console.error("❌ Error sending status change notification:", error);
        }
      });
    }
  }
});

const Order = model("Order", orderSchema);

export default Order;
