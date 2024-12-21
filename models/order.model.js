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
  },
  { timestamps: true }
);


const orderSchema = new Schema(
  {
    orderId: {
      type: String, // Change to String
      unique: true, // Ensure uniqueness
      sparse: true, // Allow documents without orderId temporarilyet
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
      required: true,
    },
    remark: {
      type: String,
      required: true,
  },
    payment: [paymentSchema],
    notes: {
      type: String,
    },
    orderStatus: {
      type: String,
      enum: ["pending", "processing", "completed", "cancelled", "Pending"],
      default: "pending",
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
    const maxOrder = await this.constructor.findOne().sort({ orderId: -1 }).select("orderId");
    this.orderId = maxOrder ? maxOrder.orderId + 1 : 1; // Increment the highest orderId or start with 1
    next();
  } catch (err) {
    next(err);
  }
});

const Order = model("Order", orderSchema);

export default Order;
