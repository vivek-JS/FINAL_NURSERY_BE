import { Schema, model } from "mongoose";

const dealerBookingSchema = new Schema({
  dealer: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  
  orders: [{
    type: Schema.Types.ObjectId,
    ref: "DealerOrder"
  }],
  
  farmerOrders: [{
    type: Schema.Types.ObjectId,
    ref: "Orders"
  }],

  summary: {
    totalAvailable: {
      type: Number,
      default: 0
    },
    totalBooked: {
      type: Number,
      default: 0
    },
    totalBalance: {
      type: Number,
      default: 0
    },
    paymentRemaining: {
      type: Number,
      default: 0
    },
    totalOrderPayments: {
      type: Number,
      default: 0
    }
  },
}, {
  timestamps: true
});

// Add indexes for better query performance
dealerBookingSchema.index({ dealer: 1 });
dealerBookingSchema.index({ 'summary.totalBalance': 1 });
dealerBookingSchema.index({ 'summary.paymentRemaining': 1 });

const DealerBooking = model("DealerBooking", dealerBookingSchema);

export default DealerBooking;