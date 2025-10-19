import mongoose from 'mongoose';

const measurementUnitSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    abbreviation: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ['weight', 'volume', 'length', 'quantity', 'area'],
      required: true,
    },
    conversionToBase: {
      type: Number,
      required: true,
      default: 1,
    },
    baseUnit: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MeasurementUnit',
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
measurementUnitSchema.index({ name: 1 });
measurementUnitSchema.index({ type: 1 });

const MeasurementUnit = mongoose.model('MeasurementUnit', measurementUnitSchema);

export default MeasurementUnit;

