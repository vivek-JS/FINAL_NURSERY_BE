import { Schema, model } from "mongoose";

export const DRIVER_PAYMENT_STATUSES = ["UNPAID", "PARTIAL", "PAID"];
export const DRIVER_PAY_MODES = ["CASH", "UPI", "NEFT", "CHEQUE", "OTHER"];

const receiptSchema = new Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    receiptNumber: { type: String, default: "", trim: true },
    utrNumber: { type: String, default: "", trim: true },
    chequeNumber: { type: String, default: "", trim: true },
    bankName: { type: String, default: "", trim: true },
    receiptPayeeName: { type: String, default: "", trim: true },
    receiptPhoto: { type: [String], default: [] },
    paidAt: { type: Date, default: Date.now },
    mode: { type: String, enum: DRIVER_PAY_MODES, default: "CASH" },
    note: { type: String, default: "", trim: true },
    paidBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    paidByName: { type: String, default: "" },
  },
  { _id: true }
);

const driverPaymentSchema = new Schema(
  {
    dispatchId: { type: Schema.Types.ObjectId, ref: "Dispatch", required: true },
    freightSlipId: { type: Schema.Types.ObjectId, ref: "FreightSlip", default: null },
    slipNumber: { type: String, default: "" },
    slipDate: { type: Date, default: null },
    transportId: { type: String, default: "" },

    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", default: null },
    vehicleName: { type: String, default: "" },
    vehicleNumber: { type: String, default: "" },
    ownerId: { type: Schema.Types.ObjectId, ref: "VehicleOwner", default: null },
    ownerName: { type: String, default: "" },
    driverId: { type: Schema.Types.ObjectId, ref: "VehicleDriver", default: null },
    driverName: { type: String, default: "" },
    driverMobile: { type: String, default: "" },

    amount: { type: Number, required: true, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: DRIVER_PAYMENT_STATUSES, default: "UNPAID" },
    finalizedAt: { type: Date, default: Date.now },
    payments: { type: [receiptSchema], default: [] },
  },
  { timestamps: true }
);

driverPaymentSchema.index({ dispatchId: 1 }, { unique: true });
driverPaymentSchema.index({ freightSlipId: 1 });
driverPaymentSchema.index({ status: 1, finalizedAt: -1 });
driverPaymentSchema.index({ ownerId: 1, status: 1 });
driverPaymentSchema.index({ vehicleNumber: 1, status: 1 });

export default model("DriverPayment", driverPaymentSchema);
