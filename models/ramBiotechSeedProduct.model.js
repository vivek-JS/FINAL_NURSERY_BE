import mongoose from 'mongoose';

const varietySchema = new mongoose.Schema(
  {
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
    tentativePlantsPerPacket: {
      type: Number,
      min: 0,
    },
    displayOrder: {
      type: Number,
      min: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    /** Nursery plant/subtype for sowing (same role as Agri sowing link). */
    sowingPlantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PlantCms',
    },
    sowingSubtypeId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    /** Ram Biotech inventory SKU (Product). */
    linkedInventoryProductId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
    },
  },
  { _id: true, timestamps: false }
);

const ramBiotechSeedProductSchema = new mongoose.Schema(
  {
    plantName: {
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
    displayOrder: {
      type: Number,
      min: 0,
      index: true,
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
  { timestamps: true }
);

ramBiotechSeedProductSchema.index({ plantName: 1 });
ramBiotechSeedProductSchema.index({ isActive: 1 });
ramBiotechSeedProductSchema.index({ displayOrder: 1, plantName: 1 });

const RamBiotechSeedProduct = mongoose.model('RamBiotechSeedProduct', ramBiotechSeedProductSchema);

export default RamBiotechSeedProduct;
