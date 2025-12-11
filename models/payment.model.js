import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema(
  {
    merchant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      required: true,
    },
    sellOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SellOrder',
    },
    paidAmount: {
      type: Number,
      required: true,
    },
    paymentDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    modeOfPayment: {
      type: String,
      enum: ['Cash', 'UPI', 'Cheque', 'NEFT/RTGS', 'Card', 'Bank Transfer'],
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ['PENDING', 'COLLECTED', 'REJECTED'],
      default: 'PENDING',
    },
    bankName: String,
    transactionId: String,
    chequeNumber: String,
    upiId: String,
    receiptPhoto: [String],
    remark: String,
    isWalletPayment: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
paymentSchema.index({ merchant: 1 });
paymentSchema.index({ sellOrder: 1 });
paymentSchema.index({ paymentDate: -1 });
paymentSchema.index({ paymentStatus: 1 });

const Payment = mongoose.model('Payment', paymentSchema);

export default Payment;



