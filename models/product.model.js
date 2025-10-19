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
      enum: ['raw_material', 'packaging', 'finished_good', 'consumable', 'other'],
      required: true,
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
    },
    stockValue: {
      type: Number,
      default: 0,
    },
    averagePrice: {
      type: Number,
      default: 0,
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
productSchema.index({ code: 1 });
productSchema.index({ name: 1 });
productSchema.index({ category: 1 });
productSchema.index({ isActive: 1 });

const Product = mongoose.model('Product', productSchema);

export default Product;

