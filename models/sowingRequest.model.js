import mongoose from 'mongoose';

const sowingRequestSchema = new mongoose.Schema(
  {
    requestNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    plantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PlantCms',
      required: true,
    },
    plantName: {
      type: String,
      required: true,
    },
    subtypeId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    subtypeName: {
      type: String,
      required: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    packetsNeeded: {
      type: Number,
      required: true,
      min: 0.01,
    },
    packetsRequested: {
      type: Number,
      required: true,
      min: 0.01,
    },
    excessPackets: {
      type: Number,
      default: 0,
      min: 0,
    },
    primaryUnit: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MeasurementUnit',
    },
    secondaryUnit: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MeasurementUnit',
    },
    conversionFactor: {
      type: Number,
      default: 1,
    },
    unitName: {
      type: String,
      default: 'packets',
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'issued', 'cancelled', 'rejected'],
      default: 'pending',
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
    },
    requestedDate: {
      type: Date,
      default: Date.now,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    issuedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    issuedDate: {
      type: Date,
    },
    outwardId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InventoryOutward',
    },
    notes: {
      type: String,
    },
    // Sowing progress tracking
    sowingInProgress: {
      type: Boolean,
      default: false,
    },
    sowingStartedDate: {
      type: Date,
    },
    sowingCompleted: {
      type: Boolean,
      default: false,
    },
    sowingCompletedDate: {
      type: Date,
    },
    sowedQuantity: {
      type: Number,
      default: 0,
    },
    remainingSowingNeeded: {
      type: Number,
      default: 0,
    },
    linkedSlotIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PlantSlot',
    }],
    isExcessiveSowing: {
      type: Boolean,
      default: false,
    }, // Flag to mark excessive sowing (no orders)
    // Cancellation tracking
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    cancelledDate: {
      type: Date,
    },
    cancellationReason: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// Generate request number
sowingRequestSchema.statics.generateRequestNumber = async function () {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
  const count = await this.countDocuments({
    requestNumber: new RegExp(`^SR${dateStr}`),
  });
  return `SR${dateStr}${String(count + 1).padStart(4, '0')}`;
};

// Indexes
sowingRequestSchema.index({ plantId: 1, subtypeId: 1 });
sowingRequestSchema.index({ status: 1 });
sowingRequestSchema.index({ requestedDate: -1 });
sowingRequestSchema.index({ productId: 1 });

const SowingRequest = mongoose.model('SowingRequest', sowingRequestSchema);

export default SowingRequest;

