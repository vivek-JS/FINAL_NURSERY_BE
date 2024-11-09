import mongoose, { Schema, model } from "mongoose";

const paymentSchema = new Schema(
  {
    paidAmount: {
      type: Number,
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
    typeOfPlants: {
      type: String,
      required: true,
    },
    numberOfPlants: {
      type: Number,
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
    }
  },
  { timestamps: true }
);

const Order = model("Order", orderSchema);

export default Order;
