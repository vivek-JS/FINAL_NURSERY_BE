import mongoose from 'mongoose';

const grnItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  poItem: {
    type: mongoose.Schema.Types.ObjectId,
  },
  batchNumber: {
    type: String,
    required: true,
    trim: true,
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
  rate: {
    type: Number,
    required: true,
  },
  manufactureDate: {
    type: Date,
  },
  expiryDate: {
    type: Date,
  },
  acceptedQuantity: {
    type: Number,
    required: true,
  },
  rejectedQuantity: {
    type: Number,
    default: 0,
  },
  damageQuantity: {
    type: Number,
    default: 0,
  },
  amount: {
    type: Number,
    required: true,
  },
  batch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch',
  },
  slotId: {
    type: mongoose.Schema.Types.ObjectId,
    // Reference to slot for updating availablePlants when GRN is approved
  },
  notes: String,
});

const grnSchema = new mongoose.Schema(
  {
    grnNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    grnDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Supplier',
      required: true,
    },
    purchaseOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PurchaseOrder',
    },
    invoiceNumber: {
      type: String,
      trim: true,
    },
    invoiceDate: {
      type: Date,
    },
    challanNumber: {
      type: String,
      trim: true,
    },
    challanDate: {
      type: Date,
    },
    vehicleNumber: {
      type: String,
      trim: true,
    },
    driverName: {
      type: String,
      trim: true,
    },
    items: [grnItemSchema],
    subtotal: {
      type: Number,
      required: true,
    },
    gstAmount: {
      type: Number,
      default: 0,
    },
    freightCharges: {
      type: Number,
      default: 0,
    },
    otherCharges: {
      type: Number,
      default: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ['draft', 'quality_check', 'approved', 'rejected', 'partial_accepted'],
      default: 'draft',
    },
    qualityCheckBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    qualityCheckDate: {
      type: Date,
    },
    qualityCheckRemarks: {
      type: String,
    },
    attachments: [{
      name: String,
      url: String,
      type: String,
    }],
    notes: {
      type: String,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
grnSchema.index({ grnNumber: 1 });
grnSchema.index({ supplier: 1 });
grnSchema.index({ purchaseOrder: 1 });
grnSchema.index({ status: 1 });
grnSchema.index({ grnDate: -1 });

// Generate GRN number
grnSchema.statics.generateGRNNumber = async function() {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  
  const lastGRN = await this.findOne({
    grnNumber: new RegExp(`^GRN${year}${month}`)
  }).sort({ grnNumber: -1 });
  
  let sequence = 1;
  if (lastGRN) {
    const lastSequence = parseInt(lastGRN.grnNumber.slice(-4));
    sequence = lastSequence + 1;
  }
  
  return `GRN${year}${month}${sequence.toString().padStart(4, '0')}`;
};

const GRN = mongoose.model('GRN', grnSchema);

export default GRN;

