import mongoose from 'mongoose';

const sellOrderItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
  },
  unit: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MeasurementUnit',
  },
  rate: {
    type: Number,
    required: true,
  },
  discount: {
    type: Number,
    default: 0,
  },
  gst: {
    type: Number,
    default: 0,
  },
  amount: {
    type: Number,
    required: true,
  },
  batchNumber: String,
  notes: String,
});

const paymentSchema = new mongoose.Schema({
  paidAmount: {
    type: Number,
    required: true,
  },
  paymentDate: {
    type: Date,
    required: true,
    default: Date.now,
  },
  modeOfPayment: {
    type: String,
    enum: ['Cash', 'UPI', 'Cheque', 'NEFT/RTGS', 'Card', 'Bank Transfer'],
    required: true,
  },
  paymentStatus: {
    type: String,
    enum: ['PENDING', 'COLLECTED', 'REJECTED'],
    default: 'PENDING',
  },
  bankName: String,
  transactionId: String,
  chequeNumber: String,
  upiId: String,
  receiptPhoto: [String],
  remark: String,
  isWalletPayment: {
    type: Boolean,
    default: false,
  },
}, { timestamps: true });

const sellOrderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    merchant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      required: false, // Optional - buyer can be identified by name/village
    },
    buyerName: {
      type: String,
      trim: true,
    },
    buyerVillage: {
      type: String,
      trim: true,
    },
    orderDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    deliveryDate: {
      type: Date,
    },
    items: [sellOrderItemSchema],
    subtotal: {
      type: Number,
      required: true,
    },
    discountAmount: {
      type: Number,
      default: 0,
    },
    gstAmount: {
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
    payment: [paymentSchema],
    paymentStatus: {
      type: String,
      enum: ['pending', 'partial', 'paid'],
      default: 'pending',
    },
    paidAmount: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['draft', 'pending', 'confirmed', 'dispatched', 'delivered', 'cancelled'],
      default: 'draft',
    },
    vehicleDetails: {
      number: String,
      type: String,
      driverName: String,
      driverContact: String,
    },
    notes: String,
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
// Note: orderNumber already has unique: true which creates an index, so we don't need to index it again
sellOrderSchema.index({ merchant: 1 });
sellOrderSchema.index({ orderDate: -1 });
sellOrderSchema.index({ status: 1 });
sellOrderSchema.index({ paymentStatus: 1 });

// Static method to generate order number
sellOrderSchema.statics.generateOrderNumber = async function () {
  const count = await this.countDocuments();
  const year = new Date().getFullYear();
  return `MSO${year}${String(count + 1).padStart(6, '0')}`; // MSO = Merchant Sell Order
};

// Method to calculate payment totals
sellOrderSchema.methods.calculatePaymentTotals = function () {
  const totalPaid = this.payment
    .filter(p => p.paymentStatus === 'COLLECTED')
    .reduce((sum, p) => sum + p.paidAmount, 0);
  
  this.paidAmount = totalPaid;
  
  if (totalPaid >= this.totalAmount) {
    this.paymentStatus = 'paid';
  } else if (totalPaid > 0) {
    this.paymentStatus = 'partial';
  } else {
    this.paymentStatus = 'pending';
  }
  
  return {
    totalPaid,
    remaining: this.totalAmount - totalPaid,
    paymentStatus: this.paymentStatus,
  };
};

// Check if model already exists to avoid overwrite errors
// Note: There's an older SellOrder model in purchase.model.js for farmer-based orders
// This one is for merchant-based orders. If the old one exists, we'll use a different name.
const MerchantSellOrder = mongoose.models.MerchantSellOrder || mongoose.model('MerchantSellOrder', sellOrderSchema);

export default MerchantSellOrder;

