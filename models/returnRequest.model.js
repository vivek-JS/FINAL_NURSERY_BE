import mongoose from 'mongoose';

const returnRequestSchema = new mongoose.Schema(
  {
    requestNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    returnType: {
      type: String,
      enum: ['sowing', 'packet', 'other'],
      required: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    batch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Batch',
    },
    quantity: {
      type: Number,
      required: true,
      min: 0.01,
    },
    unit: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MeasurementUnit',
      required: true,
    },
    // Reference to the source (sowing, outward, etc.)
    referenceType: {
      type: String,
      enum: ['Sowing', 'Outward', 'Other'],
      required: true,
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    referenceNumber: {
      type: String,
    },
    // Outward item details (for packet returns)
    outwardId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InventoryOutward',
    },
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    // Original quantities for tracking
    originalQuantity: {
      type: Number,
    },
    usedQuantity: {
      type: Number,
    },
    remainingQuantity: {
      type: Number,
      required: true,
    },
    reason: {
      type: String,
      trim: true,
      default: 'Return from complete sowing - remaining stock',
    },
    remarks: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    requestedDate: {
      type: Date,
      default: Date.now,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    approvedDate: {
      type: Date,
    },
    rejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    rejectedDate: {
      type: Date,
    },
    rejectionReason: {
      type: String,
      trim: true,
    },
    // Metadata for additional information
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
returnRequestSchema.index({ requestNumber: 1 });
returnRequestSchema.index({ status: 1 });
returnRequestSchema.index({ product: 1 });
returnRequestSchema.index({ requestedBy: 1 });
returnRequestSchema.index({ requestedDate: -1 });

// Static method to generate unique request number
returnRequestSchema.statics.generateRequestNumber = async function() {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  
  const lastRequest = await this.findOne({
    requestNumber: new RegExp(`^RR${year}${month}${day}`)
  }).sort({ requestNumber: -1 });
  
  let sequence = 1;
  if (lastRequest) {
    const lastSequence = parseInt(lastRequest.requestNumber.slice(-4));
    sequence = lastSequence + 1;
  }
  
  return `RR${year}${month}${day}${sequence.toString().padStart(4, '0')}`;
};

const ReturnRequest = mongoose.model('ReturnRequest', returnRequestSchema);

export default ReturnRequest;



