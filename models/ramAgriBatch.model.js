import mongoose from 'mongoose';

const ramAgriBatchSchema = new mongoose.Schema(
  {
    batchNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    ramAgriCropId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RamAgriInputsProduct',
      required: true,
      index: true,
    },
    ramAgriVarietyId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    manufactureDate: { type: Date },
    expiryDate: { type: Date },
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
      min: 0,
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
    source: {
      type: String,
      enum: ['GRN', 'PO', 'MANUAL_ADJUSTMENT', 'OPENING_BALANCE', 'SALES_RETURN'],
      default: 'GRN',
    },
    referenceType: {
      type: String,
      trim: true,
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    referenceNumber: {
      type: String,
      trim: true,
    },
    grn: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'GRN',
    },
    purchaseOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PurchaseOrder',
    },
    notes: { type: String },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

ramAgriBatchSchema.index({ ramAgriCropId: 1, ramAgriVarietyId: 1, status: 1, receivedDate: 1 });
ramAgriBatchSchema.index({ batchNumber: 1 });
ramAgriBatchSchema.index({ expiryDate: 1 });

ramAgriBatchSchema.pre('save', function preSave(next) {
  if (this.remainingQuantity < 0) {
    return next(new Error('Remaining quantity cannot be negative'));
  }
  if (this.remainingQuantity <= 0) {
    this.status = 'exhausted';
  } else if (this.expiryDate && this.expiryDate < new Date()) {
    this.status = 'expired';
  } else if (this.status === 'exhausted' && this.remainingQuantity > 0) {
    this.status = 'active';
  }
  next();
});

const RamAgriBatch = mongoose.model('RamAgriBatch', ramAgriBatchSchema);

export default RamAgriBatch;
