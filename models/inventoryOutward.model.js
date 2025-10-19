import mongoose from 'mongoose';

const outwardItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  batch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch',
    required: true,
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
  },
  amount: {
    type: Number,
  },
  notes: String,
});

const inventoryOutwardSchema = new mongoose.Schema(
  {
    outwardNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    outwardDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    purpose: {
      type: String,
      enum: ['production', 'sales', 'transfer', 'wastage', 'return', 'sample', 'other'],
      required: true,
    },
    purposeDetails: {
      type: String,
    },
    department: {
      type: String,
      trim: true,
    },
    recipientName: {
      type: String,
      trim: true,
    },
    recipientPhone: {
      type: String,
      trim: true,
    },
    destination: {
      type: String,
      trim: true,
    },
    items: [outwardItemSchema],
    totalAmount: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['draft', 'pending', 'approved', 'issued', 'cancelled'],
      default: 'draft',
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    approvedDate: {
      type: Date,
    },
    issuedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    issuedDate: {
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
inventoryOutwardSchema.index({ outwardNumber: 1 });
inventoryOutwardSchema.index({ purpose: 1 });
inventoryOutwardSchema.index({ status: 1 });
inventoryOutwardSchema.index({ outwardDate: -1 });

// Generate Outward number
inventoryOutwardSchema.statics.generateOutwardNumber = async function() {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  
  const lastOutward = await this.findOne({
    outwardNumber: new RegExp(`^OUT${year}${month}`)
  }).sort({ outwardNumber: -1 });
  
  let sequence = 1;
  if (lastOutward) {
    const lastSequence = parseInt(lastOutward.outwardNumber.slice(-4));
    sequence = lastSequence + 1;
  }
  
  return `OUT${year}${month}${sequence.toString().padStart(4, '0')}`;
};

const InventoryOutward = mongoose.model('InventoryOutward', inventoryOutwardSchema);

export default InventoryOutward;

