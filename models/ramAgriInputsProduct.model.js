import mongoose from 'mongoose';

const rateSchema = new mongoose.Schema({
  minRate: {
    type: Number,
    min: 0,
    // Not required - validation is handled in controller when adding rates
  },
  maxRate: {
    type: Number,
    min: 0,
    // Not required - validation is handled in controller when adding rates
  },
  // Keep rate for backward compatibility (will be calculated as average)
  rate: {
    type: Number,
    default: function() {
      return this.minRate && this.maxRate ? (this.minRate + this.maxRate) / 2 : 0;
    },
  },
  startDate: {
    type: Date,
    // Not required - validation is handled in controller when adding rates
  },
  endDate: {
    type: Date,
    // Not required - validation is handled in controller when adding rates
  },
  season: {
    type: String,
    trim: true,
    comment: "Optional season name like 'Summer 2024', 'Winter 2024', etc.",
  },
  notes: {
    type: String,
    trim: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, {
  _id: true,
  timestamps: true,
});

const varietySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    trim: true,
  },
  primaryUnit: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MeasurementUnit',
    required: true,
  },
  secondaryUnit: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MeasurementUnit',
  },
  conversionFactor: {
    type: Number,
    default: 1,
  },
  defaultRate: {
    type: Number,
    min: 0,
    comment: "Default rate for this variety (can be overridden by seasonal rates)",
  },
  sellerRate: {
    type: Number,
    min: 0,
    comment: "Seller-facing rate (from Ram Agri chemical master sheet)",
  },
  dealerRate: {
    type: Number,
    min: 0,
    comment: "Dealer rate (from Ram Agri chemical master sheet)",
  },
  points: {
    type: Number,
    default: 0,
    min: 0,
    comment: "Seller points for the variety/package",
  },
  dealerPoints: {
    type: Number,
    default: 0,
    min: 0,
    comment: "Dealer points for the variety/package",
  },
  purchasePrice: {
    type: Number,
    min: 0,
    comment: "Purchase price per unit for this variety",
  },
  currentStock: {
    type: Number,
    default: 0,
    min: 0,
    comment: "Current stock quantity for this variety",
  },
  stockValue: {
    type: Number,
    default: 0,
    min: 0,
    comment: "Total value of current stock",
  },
  averagePrice: {
    type: Number,
    default: 0,
    min: 0,
    comment: "Average price per unit based on purchase history",
  },
  rates: {
    type: [rateSchema],
    default: [],
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  /** Sort order within this crop’s variety / pack dropdown (lower = earlier). */
  displayOrder: {
    type: Number,
    default: 0,
    min: 0,
  },
}, {
  _id: true,
  timestamps: false,
});

const ramAgriInputsProductSchema = new mongoose.Schema(
  {
    productType: {
      type: String,
      enum: ['seed', 'chemical'],
      default: 'seed',
      index: true,
    },
    cropName: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
    },
    varieties: {
      type: [varietySchema],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
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
    /**
     * Sort order for master list + all product (crop) dropdowns — seed/chemical lists are ordered separately.
     * Lower numbers appear first. Defaults to 0 for legacy rows; set explicitly from master UI.
     */
    displayOrder: {
      type: Number,
      default: 0,
      min: 0,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for better query performance
ramAgriInputsProductSchema.index({ productType: 1, cropName: 1 });
ramAgriInputsProductSchema.index({ productType: 1, displayOrder: 1, cropName: 1 });
ramAgriInputsProductSchema.index({ cropName: 1 });
ramAgriInputsProductSchema.index({ isActive: 1 });
ramAgriInputsProductSchema.index({ createdAt: -1 });

const RamAgriInputsProduct = mongoose.model('RamAgriInputsProduct', ramAgriInputsProductSchema);

export default RamAgriInputsProduct;

