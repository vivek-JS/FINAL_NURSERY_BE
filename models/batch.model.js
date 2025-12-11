import mongoose from 'mongoose';

const batchSchema = new mongoose.Schema(
  {
    batchNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    manufactureDate: {
      type: Date,
    },
    expiryDate: {
      type: Date,
    },
    receivedDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Supplier',
    },
    purchasePrice: {
      type: Number,
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    remainingQuantity: {
      type: Number,
      required: true,
      min: 0,
    },
    unit: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MeasurementUnit',
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'exhausted', 'expired', 'blocked'],
      default: 'active',
    },
    grn: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'GRN',
    },
    notes: {
      type: String,
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
batchSchema.index({ batchNumber: 1 });
batchSchema.index({ product: 1 });
batchSchema.index({ status: 1 });
batchSchema.index({ expiryDate: 1 });

// Auto-update status based on quantity and expiry
batchSchema.pre('save', function(next) {
  // Prevent negative quantities
  if (this.remainingQuantity < 0) {
    return next(new Error('Remaining quantity cannot be negative'));
  }
  
  // Auto-update status
  if (this.remainingQuantity <= 0) {
    this.status = 'exhausted';
  } else if (this.expiryDate && this.expiryDate < new Date()) {
    this.status = 'expired';
  } else if (this.status === 'exhausted' && this.remainingQuantity > 0) {
    // Reactivate if quantity is added back
    this.status = 'active';
  }
  
  next();
});

// Virtual for batch availability
batchSchema.virtual('isAvailable').get(function() {
  return this.status === 'active' && this.remainingQuantity > 0;
});

const Batch = mongoose.model('Batch', batchSchema);

export default Batch;
