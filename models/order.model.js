import mongoose, { Schema, model } from "mongoose";

const paymentSchema = new Schema(
  {
    paidAmount: {
      type: Number,
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ["COLLECTED", "REJECTED", "PENDING"], // Updated to enum with specified statuses
      default: "PENDING", // Default to `PENDING`
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
        type: String,
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
      // Reference to PlantCms model
      type: Schema.Types.ObjectId,
      ref: "PlantCms",
      required: true,
    },
    plantSubtype: {
      // Reference to a specific subtype in PlantCms
      type: Schema.Types.ObjectId,
      ref: "PlantCms.subtypes", // Reference to the subtypes array within the PlantCms model
      required: true,
    },
    bookingSlot: {
      // Reference to the specific subtypeSlot in PlantSlot
      type: Schema.Types.ObjectId,
      ref: "PlantSlot.subtypeSlots", // Reference to the subtypeSlots array in the PlantSlot model
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
    payment: [paymentSchema],
    notes: {
      type: String,
    },
    orderStatus: {
      type: String,
      enum: ["pending", "processing", "completed", "cancelled"],
      default: "pending",
    },
  },
  { timestamps: true }
);

const Order = model("Order", orderSchema);

export default Order;
