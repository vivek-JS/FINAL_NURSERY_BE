import { Schema, model } from "mongoose";

const tripSchema = new Schema(
  {
    vehicleId: {
      type: Schema.Types.ObjectId,
      ref: "Vehicle",
      required: true,
    },
    vehicleName: {
      type: String,
      required: true,
    },
    vehicleNumber: {
      type: String,
      required: true,
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
    const count = await this.constructor.countDocuments();
    const year = new Date().getFullYear();
    this.tripNumber = `TRIP-${year}-${String(count + 1).padStart(4, "0")}`;
  }
  next();
});

// Indexes
tripSchema.index({ vehicleId: 1 });
tripSchema.index({ status: 1 });
tripSchema.index({ startDate: -1 });
tripSchema.index({ tripNumber: 1 });

export default model("Trip", tripSchema);



