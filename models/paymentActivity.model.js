import mongoose from 'mongoose';

const paymentActivitySchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
    },
    paymentId: {
      type: String,
    },
    activityType: {
      type: String,
      enum: ['PAYMENT_ADDED', 'PAYMENT_UPDATED', 'PAYMENT_STATUS_CHANGED', 'PAYMENT_DELETED'],
      required: true,
    },
    activityDescription: {
      type: String,
    },
    paymentType: {
      type: String,
      enum: ['farmer', 'ram-agri-sales'],
    },
    paymentAmount: {
      type: Number,
    },
    previousStatus: {
      type: String,
      enum: ['PENDING', 'COLLECTED', 'REJECTED'],
    },
    newStatus: {
      type: String,
      enum: ['PENDING', 'COLLECTED', 'REJECTED'],
    },
    performedBy: {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
      name: String,
      email: String,
      phoneNumber: Number,
      role: String,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
paymentActivitySchema.index({ timestamp: -1 });
paymentActivitySchema.index({ 'performedBy.userId': 1 });
paymentActivitySchema.index({ orderId: 1 });
paymentActivitySchema.index({ activityType: 1 });
paymentActivitySchema.index({ paymentType: 1 });

const PaymentActivity = mongoose.model('PaymentActivity', paymentActivitySchema);

export default PaymentActivity;
