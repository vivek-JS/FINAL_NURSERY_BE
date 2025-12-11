import mongoose from 'mongoose';

const inventoryTransactionSchema = new mongoose.Schema(
  {
    transactionNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    transactionDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    transactionType: {
      type: String,
      enum: ['inward', 'outward', 'adjustment', 'transfer', 'return'],
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
    },
    unit: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MeasurementUnit',
      required: true,
    },
    balanceBeforeTransaction: {
      type: Number,
      required: true,
    },
    balanceAfterTransaction: {
      type: Number,
      required: true,
    },
    rate: {
      type: Number,
    },
    value: {
      type: Number,
    },
    referenceType: {
      type: String,
      enum: ['GRN', 'PurchaseOrder', 'Outward', 'Adjustment', 'Transfer', 'SellOrder'],
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    referenceNumber: {
      type: String,
    },
    fromLocation: {
      type: String,
      trim: true,
    },
    toLocation: {
      type: String,
      trim: true,
    },
    reason: {
      type: String,
      trim: true,
    },
    remarks: {
      type: String,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
inventoryTransactionSchema.index({ transactionNumber: 1 });
inventoryTransactionSchema.index({ product: 1 });
inventoryTransactionSchema.index({ batch: 1 });
inventoryTransactionSchema.index({ transactionType: 1 });
inventoryTransactionSchema.index({ transactionDate: -1 });
inventoryTransactionSchema.index({ referenceType: 1, referenceId: 1 });

// Generate Transaction number
inventoryTransactionSchema.statics.generateTransactionNumber = async function() {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  
  const lastTransaction = await this.findOne({
    transactionNumber: new RegExp(`^TXN${year}${month}${day}`)
  }).sort({ transactionNumber: -1 });
  
  let sequence = 1;
  if (lastTransaction) {
    const lastSequence = parseInt(lastTransaction.transactionNumber.slice(-4));
    sequence = lastSequence + 1;
  }
  
  return `TXN${year}${month}${day}${sequence.toString().padStart(4, '0')}`;
};

const InventoryTransaction = mongoose.model('InventoryTransaction', inventoryTransactionSchema);

export default InventoryTransaction;

