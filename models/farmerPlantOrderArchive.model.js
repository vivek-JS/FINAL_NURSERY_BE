import mongoose from "mongoose";

/**
 * Immutable snapshot of a farmer plant order at hard-delete time.
 */
const farmerPlantOrderArchiveSchema = new mongoose.Schema(
  {
    originalOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: true,
      index: true,
    },
    orderId: {
      type: Number,
      index: true,
    },
    snapshot: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    deletedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    deleteReason: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

farmerPlantOrderArchiveSchema.index({ "snapshot.farmer": 1, deletedAt: -1 });

const immutableArchiveOps = [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "findByIdAndUpdate",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
  "findByIdAndDelete",
];

immutableArchiveOps.forEach((operation) => {
  farmerPlantOrderArchiveSchema.pre(operation, function (next) {
    next(new Error("Farmer plant order archive entries are immutable."));
  });
});

const FarmerPlantOrderArchive = mongoose.model(
  "FarmerPlantOrderArchive",
  farmerPlantOrderArchiveSchema
);

export default FarmerPlantOrderArchive;
