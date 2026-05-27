import mongoose, { Schema, model } from "mongoose";

const readyDispatchGroupSchema = new Schema(
  {
    groupCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["DRAFT", "LOCKED", "DISPATCHED", "CANCELLED"],
      default: "DRAFT",
      index: true,
    },
    orderIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "Order",
        required: true,
      },
    ],
    totalPlants: {
      type: Number,
      default: 0,
      min: 0,
    },
    capacityMeta: {
      type: {
        type: String,
        trim: true,
      },
      unit: {
        type: String,
        trim: true,
      },
      max: {
        type: Number,
        min: 0,
      },
    },
    vehicleRef: {
      type: String,
      trim: true,
    },
    driverRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "VehicleOwner",
      default: null,
    },
    vehicleId: {
      type: Schema.Types.ObjectId,
      ref: "Vehicle",
      default: null,
    },
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "VehicleDriver",
      default: null,
    },
    vehicleNumber: { type: String, trim: true, default: "" },
    vehicleName: { type: String, trim: true, default: "" },
    driverName: { type: String, trim: true, default: "" },
    driverMobile: { type: String, trim: true, default: "" },
    routeId: { type: String, trim: true, default: "" },
    routeNotes: { type: String, trim: true, default: "" },
    driverRemark: { type: String, trim: true, default: "" },
    vehicleRemark: { type: String, trim: true, default: "" },
    dispatchDayKey: {
      type: String,
      enum: ["TODAY", "TOMORROW", "DAY_AFTER"],
    },
    dispatchTargetDate: {
      type: Date,
    },
    notes: {
      type: String,
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    convertedDispatchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Dispatch",
    },
  },
  { timestamps: true }
);

readyDispatchGroupSchema.index({ orderIds: 1, status: 1 });
readyDispatchGroupSchema.index({ dispatchTargetDate: 1, status: 1 });
readyDispatchGroupSchema.index({ status: 1, routeId: 1, vehicleId: 1 });

const ReadyDispatchGroup = model("ReadyDispatchGroup", readyDispatchGroupSchema);

export default ReadyDispatchGroup;
