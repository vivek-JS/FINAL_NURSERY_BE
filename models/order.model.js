import mongoose, { Schema, model } from "mongoose";

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
      //  required: true,
    },
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
    farmer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Farmer",
      required: true,
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
  },
  { timestamps: true }
);

// Indexes
orderSchema.index({ farmer: 1 });
orderSchema.index({ salesPerson: 1 });
orderSchema.index({ plantName: 1 });
orderSchema.index({ bookingSlot: 1 });
orderSchema.index({ orderStatus: 1 });
orderSchema.index({ createdAt: 1 });
orderSchema.index({ orderPaymentStatus: 1 });
orderSchema.index({ createdAt: 1, orderStatus: 1 });

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

// Pre-save middleware to generate unique orderId
orderSchema.pre("save", async function (next) {
  if (!this.isNew || this.orderId) return next();

  try {
    const maxOrder = await this.constructor
      .findOne()
      .sort({ orderId: -1 })
      .select("orderId");
    this.orderId = maxOrder ? maxOrder.orderId + 1 : 1; // Increment the highest orderId or start with 1
    next();
  } catch (err) {
    next(err);
  }
});

// Pre-save middleware to calculate orderPaymentStatus
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

const Order = model("Order", orderSchema);

export default Order;
