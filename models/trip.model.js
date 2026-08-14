import { Schema, model } from "mongoose";
import { allocateTripNumber } from "../utility/tripNumber.js";

const tripSchema = new Schema(
  {
    vehicleId: {
      type: Schema.Types.ObjectId,
      ref: "Vehicle",
    },
    vehicleName: {
      type: String,
    },
    vehicleNumber: {
      type: String,
    },
    tripNumber: {
      type: String,
      unique: true,
      required: true,
    },
    driverName: {
      type: String,
      required: true,
    },
    driverContact: {
      type: String,
    },
    dispatchId: {
      type: Schema.Types.ObjectId,
      ref: "Dispatch",
    },
    orderIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "Order",
      },
    ],
    startDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    endDate: {
      type: Date,
    },
    status: {
      type: String,
      enum: ["pending", "in_transit", "delivered", "cancelled"],
      default: "pending",
    },
    origin: {
      address: String,
      city: String,
      state: String,
      pincode: String,
    },
    destination: {
      address: String,
      city: String,
      state: String,
      pincode: String,
      contactPerson: String,
      contactNumber: String,
    },
    totalPlants: {
      type: Number,
      default: 0,
    },
    totalCrates: {
      type: Number,
      default: 0,
    },
    notes: String,
    kmRun: { type: Number, default: null },
    rent: { type: Number, default: null },
    otherCharges: { type: Number, default: null },
    tripRemark: { type: String, default: "" },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    completedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

// Pre-save middleware to generate trip number
tripSchema.pre("save", async function (next) {
  if (this.isNew && !this.tripNumber) {
    this.tripNumber = await allocateTripNumber(this.constructor);
  }
  next();
});

// findOneAndUpdate upsert bypasses save — set tripNumber on insert only
tripSchema.pre("findOneAndUpdate", async function (next) {
  try {
    const opts = this.getOptions();
    if (!opts?.upsert) return next();
    const update = this.getUpdate() || {};
    const setOnInsert = update.$setOnInsert || {};
    const set = update.$set || {};
    if (setOnInsert.tripNumber || set.tripNumber) return next();
    const transportId =
      set.transportId ??
      setOnInsert.transportId ??
      this.getQuery()?.transportId;
    update.$setOnInsert = {
      ...setOnInsert,
      tripNumber: await allocateTripNumber(this.model, { transportId }),
    };
    this.setUpdate(update);
    next();
  } catch (err) {
    next(err);
  }
});

// Indexes
tripSchema.index({ vehicleId: 1 });
tripSchema.index({ status: 1 });
tripSchema.index({ startDate: -1 });
tripSchema.index({ tripNumber: 1 });

export default model("Trip", tripSchema);



