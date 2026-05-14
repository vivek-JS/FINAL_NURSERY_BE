import mongoose from "mongoose";

const orderSnapshotSchema = new mongoose.Schema(
  {
    orderId: { type: Number, default: null },
    farmerName: { type: String, trim: true, default: "" },
    farmerMobile: { type: String, trim: true, default: "" },
    village: { type: String, trim: true, default: "" },
    plantName: { type: String, trim: true, default: "" },
    numberOfPlants: { type: Number, default: null },
  },
  { _id: false }
);

const rateChangeRequestSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    previousRate: { type: Number, required: true },
    requestedRate: { type: Number, required: true },
    notes: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "EXPIRED"],
      default: "PENDING",
      index: true,
    },
    approvalToken: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    tokenExpiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, default: "" },
    orderSnapshot: { type: orderSnapshotSchema, default: () => ({}) },
  },
  { timestamps: true }
);

rateChangeRequestSchema.index({ status: 1, createdAt: -1 });
rateChangeRequestSchema.index({ orderId: 1, status: 1 });
rateChangeRequestSchema.index({ tokenExpiresAt: 1 }, { expireAfterSeconds: 0 });

const RateChangeRequest = mongoose.model("RateChangeRequest", rateChangeRequestSchema);

export default RateChangeRequest;
