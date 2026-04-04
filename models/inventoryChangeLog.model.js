import mongoose from 'mongoose';

const inventoryChangeLogSchema = new mongoose.Schema(
  {
    entityType: {
      type: String,
      required: true,
      enum: [
        'crop',
        'variety',
        'rate',
        'product',
        'category',
        'unit',
        'batch',
        'stock',
        'purchase_order',
        'grn',
        'sell_order',
        'employee',
      ],
      index: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    action: {
      type: String,
      required: true,
      enum: ['create', 'update', 'delete', 'activate', 'deactivate'],
      index: true,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    changes: {
      type: [
        {
          field: {
            type: String,
            required: true,
          },
          oldValue: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
          },
          newValue: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
          },
        },
      ],
      default: [],
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      comment: 'Additional context like parent entity ID, related entities, etc.',
    },
    description: {
      type: String,
      trim: true,
      comment: 'Human-readable description of the change',
    },
    ipAddress: {
      type: String,
      trim: true,
    },
    userAgent: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for efficient queries
inventoryChangeLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
inventoryChangeLogSchema.index({ changedBy: 1, createdAt: -1 });
inventoryChangeLogSchema.index({ action: 1, createdAt: -1 });
inventoryChangeLogSchema.index({ createdAt: -1 });

const InventoryChangeLog = mongoose.model('InventoryChangeLog', inventoryChangeLogSchema);

export default InventoryChangeLog;


