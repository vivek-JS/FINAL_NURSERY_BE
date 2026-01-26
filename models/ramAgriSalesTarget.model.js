import mongoose from "mongoose";

const ramAgriSalesTargetSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    cropId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RamAgriInputsProduct",
      required: true,
      index: true,
    },
    varietyId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    rangeKey: {
      type: String,
      required: true,
      index: true,
    },
    targetAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

ramAgriSalesTargetSchema.index(
  { userId: 1, rangeKey: 1, cropId: 1, varietyId: 1 },
  { unique: true }
);

const RamAgriSalesTarget = mongoose.model("RamAgriSalesTarget", ramAgriSalesTargetSchema);

export default RamAgriSalesTarget;
