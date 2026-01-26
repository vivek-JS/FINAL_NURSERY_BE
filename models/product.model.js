import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
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
    description: {
      type: String,
      trim: true,
    },
    category: {
      type: String,
      required: true,
      trim: true,
    },
    purpose: {
      type: String,
      enum: ['production', 'sales', 'internal', 'other'],
      default: 'other',
      trim: true,
    },
    // Plant and subtype references (for seeds category only)
    plantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PlantCms',
    },
    subtypeId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    plantSubtypeInfo: [{
      subtypeId: {
        type: mongoose.Schema.Types.ObjectId,
      },
      conversionFactor: {
        type: Number,
        default: 1,
      },
    }],
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
    minStockLevel: {
      type: Number,
      default: 0,
    },
    maxStockLevel: {
      type: Number,
    },
    reorderLevel: {
      type: Number,
    },
    currentStock: {
      type: Number,
      default: 0,
      min: 0, // Prevent negative stock
    },
    stockValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    averagePrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    hsn: {
      type: String,
      trim: true,
    },
    gst: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isRamAgriSales: {
      type: Boolean,
      default: false,
      comment: "Flag to indicate if product is available for Ram Agri Sales orders",
    },
    ramAgriCropId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RamAgriInputsProduct',
      comment: "Reference to Ram Agri Inputs Product Master - Crop",
    },
    ramAgriVarietyId: {
      type: mongoose.Schema.Types.ObjectId,
      comment: "Reference to variety within the crop (subdocument ID)",
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

// Indexes for better query performance
productSchema.index({ code: 1 });
productSchema.index({ name: 1 });
productSchema.index({ category: 1 });
productSchema.index({ isActive: 1 });
productSchema.index({ currentStock: 1 }); // For low stock queries
productSchema.index({ createdAt: -1 }); // For recent products

// Virtual for stock status
productSchema.virtual('stockStatus').get(function() {
  if (this.currentStock <= 0) return 'out_of_stock';
  if (this.minStockLevel && this.currentStock <= this.minStockLevel) return 'low_stock';
  if (this.maxStockLevel && this.currentStock >= this.maxStockLevel) return 'overstocked';
  return 'normal';
});

// Method to calculate average price safely
productSchema.methods.calculateAveragePrice = function() {
  if (this.currentStock > 0 && this.stockValue > 0) {
    this.averagePrice = this.stockValue / this.currentStock;
  } else {
    this.averagePrice = 0;
  }
  return this.averagePrice;
};

// Pre-save hook to ensure average price is calculated
productSchema.pre('save', function(next) {
  if (this.isModified('currentStock') || this.isModified('stockValue')) {
    this.calculateAveragePrice();
  }
  next();
});

// Prevent negative stock
productSchema.pre('save', function(next) {
  if (this.currentStock < 0) {
    return next(new Error('Stock cannot be negative'));
  }
  if (this.stockValue < 0) {
    return next(new Error('Stock value cannot be negative'));
  }
  next();
});

const Product = mongoose.model('Product', productSchema);

export default Product;

