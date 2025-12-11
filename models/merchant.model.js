import mongoose from 'mongoose';

const merchantSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      enum: ['supplier', 'buyer', 'both'],
      default: 'both',
    },
    contactPerson: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      trim: true,
    },
    address: {
      street: String,
      city: String,
      state: String,
      pincode: String,
      country: { type: String, default: 'India' },
    },
    gstin: {
      type: String,
      trim: true,
    },
    pan: {
      type: String,
      trim: true,
    },
    paymentTerms: {
      type: String,
      enum: ['immediate', 'net15', 'net30', 'net45', 'net60', 'custom'],
      default: 'net30',
    },
    creditLimit: {
      type: Number,
      default: 0,
    },
    outstandingAmount: {
      type: Number,
      default: 0,
    },
    totalOrderValue: {
      type: Number,
      default: 0,
    },
    totalPaidAmount: {
      type: Number,
      default: 0,
    },
    rating: {
      type: Number,
      min: 1,
      max: 5,
    },
    isActive: {
      type: Boolean,
      default: true,
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
merchantSchema.index({ code: 1 });
merchantSchema.index({ name: 1 });
merchantSchema.index({ isActive: 1 });
merchantSchema.index({ phone: 1 });

// Static method to generate merchant code
merchantSchema.statics.generateCode = async function () {
  const count = await this.countDocuments();
  return `MER${String(count + 1).padStart(6, '0')}`;
};

const Merchant = mongoose.model('Merchant', merchantSchema);

export default Merchant;

