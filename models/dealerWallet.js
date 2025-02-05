import mongoose, { Schema, model } from "mongoose";

// Schema for individual wallet entries
const walletEntrySchema = new Schema({
  plantType: {
    type: Schema.Types.ObjectId,
    ref: "PlantCms",
    required: true
  },
  subType: {
    type: Schema.Types.ObjectId,
    ref: "PlantCms.subtypes",
    required: true
  },
  bookingSlot: {
    type: Schema.Types.ObjectId,
    ref: "PlantSlot.subtypeSlots",
  },
  quantity: {
    type: Number,
    default: 0
  },
  bookedQuantity: {
    type: Number,
    default: 0
  },
  remainingQuantity: {
    type: Number,
    default: 0
  }
}, { _id: true });

// Pre-save middleware to calculate remaining quantity
walletEntrySchema.pre('save', function(next) {
  this.remainingQuantity = this.quantity - this.bookedQuantity;
  next();
});

// Main dealer wallet schema
const dealerWalletSchema = new Schema({
  dealer: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true
  },
  availableAmount: {
    type: Number,
    default: 0
  },
  entries: [walletEntrySchema]
}, { 
  timestamps: true 
});

// Indexes for better query performance
dealerWalletSchema.index({ dealer: 1 });
dealerWalletSchema.index({ "entries.plantType": 1 });
dealerWalletSchema.index({ "entries.subType": 1 });
dealerWalletSchema.index({ "entries.bookingSlot": 1 });

const DealerWallet = model("DealerWallet", dealerWalletSchema);

export default DealerWallet;