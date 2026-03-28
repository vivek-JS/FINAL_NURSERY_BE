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

const ReadyDispatchGroup = model("ReadyDispatchGroup", readyDispatchGroupSchema);

export default ReadyDispatchGroup;
