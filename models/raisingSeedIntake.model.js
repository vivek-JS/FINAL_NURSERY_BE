import mongoose from "mongoose";

const photoSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    caption: { type: String, default: "" },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const raisingSeedIntakeSchema = new mongoose.Schema(
  {
    intakeNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      index: true,
    },
    farmerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Farmer",
    },
    farmerName: {
      type: String,
      default: "",
    },
    plantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PlantCms",
      required: true,
      index: true,
    },
    plantName: {
      type: String,
      required: true,
    },
    subtypeId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    subtypeName: {
      type: String,
      required: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
    },
    packetsReceived: {
      type: Number,
      required: true,
      min: 0.01,
    },
    packetsRemaining: {
      type: Number,
      required: true,
      min: 0,
    },
    conversionFactor: {
      type: Number,
      default: 1,
    },
    batchNumber: {
      type: String,
      required: true,
      trim: true,
    },
    expiryDate: {
      type: Date,
    },
    photos: [photoSchema],
    linkedSlotIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
      },
    ],
    notes: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["received", "allocated", "partially_used", "used", "returned"],
      default: "received",
      index: true,
    },
    source: {
      type: String,
      default: "RAISING",
    },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

raisingSeedIntakeSchema.statics.generateIntakeNumber = async function () {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, "");
  const count = await this.countDocuments({
    intakeNumber: new RegExp(`^RS${dateStr}`),
  });
  return `RS${dateStr}${String(count + 1).padStart(4, "0")}`;
};

raisingSeedIntakeSchema.index({
  plantId: 1,
  subtypeId: 1,
  status: 1,
  packetsRemaining: 1,
});

/** One raising intake per order (orderId optional for ad-hoc receives) */
raisingSeedIntakeSchema.index(
  { orderId: 1 },
  { unique: true, sparse: true }
);

const RaisingSeedIntake = mongoose.model(
  "RaisingSeedIntake",
  raisingSeedIntakeSchema
);

export default RaisingSeedIntake;
