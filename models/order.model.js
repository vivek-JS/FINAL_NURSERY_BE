import mongoose, { Schema, model } from "mongoose";

const paymentSchema = new Schema(
  {
    paidAmount: {
      type: Number,
      required: true,
    },
    paymentStatus: {
      type: Boolean,
      default: false, // Default to `false` (or set it to `true` if you prefer)
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
    typeOfPlants: {
      type: String,
      required: true,
    },
    numberOfPlants: {
      type: Number,
      required: true,
    },
    plantName: { // Reference to PlantCms model
      type: Schema.Types.ObjectId,
      ref: "PlantCms",
      required: true,
    },
    plantSubtype: { // Reference to a specific subtype in PlantCms
      type: Schema.Types.ObjectId,
      ref: "PlantCms.subtypes", // Reference to the subtypes array within the PlantCms model
      required: true,
    },
    bookingSlot: { // Reference to the specific subtypeSlot in PlantSlot
      type: Schema.Types.ObjectId,
      ref: "PlantSlot.subtypeSlots", // Reference to the subtypeSlots array in the PlantSlot model
      required: true,
    },
    modeOfPayment: {
      type: String,
    },
    rate: {
      type: Number,
      required: true,
    },
    advance: {
      type: Number,
    },
    dateOfAdvance: {
      type: Date,
    },
    bankName: {
      type: String,
    },
    receiptPhoto: [
      {
        type: String,
      },
    ],
    paymentStatus: {
      type: String,
      required: true,
    },
    payment: [paymentSchema],
    notes: {
      type: String,
    },
    orderStatus: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'cancelled'],
      default: 'Pending',
    },
  },
  { timestamps: true }
);


const Order = model("Order", orderSchema);

export default Order;
