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
      // Optional: admin/order direct sow may record plants without a seed packing product
      required: false,
    },
    packetsNeeded: {
      type: Number,
      required: true,
      min: 0,
    },
    packetsRequested: {
      type: Number,
      required: true,
      min: 0,
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
    /** Snapshot: plants per primary unit for sowing (not UOM conversionFactor) */
    tentativePlantsPerPacket: {
      type: Number,
      min: 0,
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
    laboursLadies: {
      type: Number,
      default: 0,
      min: 0,
    },
    laboursGents: {
      type: Number,
      default: 0,
      min: 0,
    },
    completionPhotos: [
      {
        url: { type: String, required: true },
        caption: { type: String, default: "" },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    completionNotes: {
      type: String,
      default: "",
    },
    /** Pollyhouse / shade where sowing was done */
    shedName: {
      type: String,
      default: "",
      trim: true,
    },
    completedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    /** Snapshot for packet vs sow reports */
    packetsIssued: {
      type: Number,
      default: 0,
      min: 0,
    },
    packetsUsed: {
      type: Number,
      default: 0,
      min: 0,
    },
    packetsReturned: {
      type: Number,
      default: 0,
      min: 0,
    },
    returnRequestIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ReturnRequest",
      },
    ],
    /** Append-only event log for audit / future reports */
    completionEvents: [
      {
        type: {
          type: String,
          enum: [
            "SOW_STARTED",
            "PLANTS_SOWED",
            "PACKETS_USED",
            "PACKETS_RETURNED",
            "INVENTORY_RESTORED",
            "ORDERS_MARKED_SOWED",
            "LABOUR_RECORDED",
            "SOW_COMPLETED",
            "PHOTO_ADDED",
            "NOTE",
          ],
          required: true,
        },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        quantity: { type: Number, default: 0 },
        unit: { type: String, default: "" },
        message: { type: String, default: "" },
        meta: { type: mongoose.Schema.Types.Mixed },
      },
    ],
    linkedSlotIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PlantSlot',
    }],
    seedSource: {
      type: String,
      enum: ['COMPANY', 'RAISING', 'MIXED'],
      default: 'COMPANY',
    },
    packetsFromCompany: {
      type: Number,
      default: 0,
      min: 0,
    },
    packetsFromRaising: {
      type: Number,
      default: 0,
      min: 0,
    },
    raisingIntakeIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RaisingSeedIntake',
    }],
    linkedOrderIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
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
    /** Auto PO when company packets exceed Biotech stock (Ram Agri → Biotech transfer). */
    transferPurchaseOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PurchaseOrder',
    },
    transferShortfallQty: {
      type: Number,
      default: 0,
      min: 0,
    },
    /**
     * Warehouse pool chosen at issue time (Office Admin).
     * Independent of seedSource (COMPANY / RAISING / MIXED).
     */
    issueInventorySource: {
      type: String,
      enum: ["BIOTECH", "RAM_AGRI", "BOTH", null],
      default: null,
    },
    packetsIssuedFromBiotech: {
      type: Number,
      default: 0,
      min: 0,
    },
    packetsIssuedFromRamAgri: {
      type: Number,
      default: 0,
      min: 0,
    },
    biotechBatchAllocations: [
      {
        batchId: { type: mongoose.Schema.Types.ObjectId, ref: "Batch" },
        batchNumber: { type: String },
        quantity: { type: Number, default: 0 },
        productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
      },
    ],
    ramAgriBatchAllocations: [
      {
        batchId: { type: mongoose.Schema.Types.ObjectId, ref: "RamAgriBatch" },
        batchNumber: { type: String },
        quantityDeducted: { type: Number, default: 0 },
        quantityReturned: { type: Number, default: 0 },
        ramAgriCropId: { type: mongoose.Schema.Types.ObjectId },
        ramAgriVarietyId: { type: mongoose.Schema.Types.ObjectId },
      },
    ],
    /** Which SubtypeInventoryLink rows were used at issue (optional audit). */
    issueLinkIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "SubtypeInventoryLink",
      },
    ],
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
sowingRequestSchema.index({ linkedOrderIds: 1 });
sowingRequestSchema.index({ sowingCompleted: 1, sowingCompletedDate: -1 });
sowingRequestSchema.index({ status: 1, sowingCompleted: 1 });

const SowingRequest = mongoose.model('SowingRequest', sowingRequestSchema);

export default SowingRequest;

