import mongoose from "mongoose";

const dealerCommissionRateSchema = new mongoose.Schema(
  {
    plantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PlantCms",
      required: true,
    },
    subtypeId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    plantName: {
      type: String,
      required: true,
      trim: true,
    },
    subtypeName: {
      type: String,
      required: true,
      trim: true,
    },
    ratePerPlant: {
      type: Number,
      required: true,
      min: 0,
      default: 1,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

dealerCommissionRateSchema.index({ plantId: 1, subtypeId: 1 }, { unique: true });
dealerCommissionRateSchema.index({ isActive: 1 });

const DealerCommissionRate = mongoose.model(
  "DealerCommissionRate",
  dealerCommissionRateSchema
);

export default DealerCommissionRate;
