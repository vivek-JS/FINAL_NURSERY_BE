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
    },
  },
  { timestamps: true }
);

const dealerOrderSchema = new Schema(
  {
    orderId: {
      type: Number,
      unique: true,
      required: true,
    },

    dealer: {
      // Changed from salesPerson to dealer
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
    bookingSlots: [
      {
        // Changed from single bookingSlot to array of bookingSlots
        type: Schema.Types.ObjectId,
        ref: "PlantSlot.subtypeSlots",
        required: true,
      },
    ],
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
dealerOrderSchema.index({ farmer: 1 });
dealerOrderSchema.index({ dealer: 1 }); // Changed from salesPerson to dealer
dealerOrderSchema.index({ plantName: 1 });
dealerOrderSchema.index({ bookingSlots: 1 }); // Updated for array of bookingSlots
dealerOrderSchema.index({ orderStatus: 1 });
dealerOrderSchema.index({ createdAt: 1 });
dealerOrderSchema.index({ orderPaymentStatus: 1 });
dealerOrderSchema.index({ createdAt: 1, orderStatus: 1 });

// Pre-save middleware to generate unique orderId
dealerOrderSchema.pre("save", async function (next) {
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

const DealerOrder = model("DealerOrder", dealerOrderSchema);

export default DealerOrder;
