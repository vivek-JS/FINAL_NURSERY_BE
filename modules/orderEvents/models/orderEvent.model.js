import mongoose from "mongoose";
import {
  APPROVAL_STATUS,
  ORDER_DOMAINS,
  ORDER_EVENT_SOURCE,
  ORDER_EVENT_TYPES,
} from "../domain/constants.js";

const approvalSchema = new mongoose.Schema(
  {
    required: { type: Boolean, default: false },
    status: {
      type: String,
      enum: Object.values(APPROVAL_STATUS),
      default: APPROVAL_STATUS.NA,
    },
    requestId: { type: mongoose.Schema.Types.ObjectId },
  },
  { _id: false }
);

const refsSchema = new mongoose.Schema(
  {
    financialEventId: { type: mongoose.Schema.Types.ObjectId, ref: "FinancialEvent" },
    voucherId: { type: mongoose.Schema.Types.ObjectId, ref: "FinanceVoucher" },
    journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry" },
    paymentId: { type: mongoose.Schema.Types.ObjectId },
    dispatchId: { type: mongoose.Schema.Types.ObjectId, ref: "Dispatch" },
    dispatchBatchId: { type: mongoose.Schema.Types.ObjectId, ref: "DispatchBatch" },
    plantOutwardId: { type: mongoose.Schema.Types.ObjectId, ref: "PlantOutward" },
    slotId: { type: mongoose.Schema.Types.ObjectId },
    rateChangeRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "RateChangeRequest" },
    transferRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "FarmerOrderTransferRequest" },
    relatedOrderId: { type: mongoose.Schema.Types.ObjectId },
    legacySource: { type: String, trim: true },
  },
  { _id: false }
);

const orderEventSchema = new mongoose.Schema(
  {
    tenantId: { type: String, default: "default", index: true },
    orderDomain: {
      type: String,
      enum: Object.values(ORDER_DOMAINS),
      required: true,
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    eventType: {
      type: String,
      enum: Object.values(ORDER_EVENT_TYPES),
      required: true,
      index: true,
    },
    idempotencyKey: { type: String, required: true, trim: true },
    field: { type: String, trim: true },
    previousValue: { type: mongoose.Schema.Types.Mixed },
    newValue: { type: mongoose.Schema.Types.Mixed },
    description: { type: String, trim: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    actorName: { type: String, trim: true },
    reason: { type: String, trim: true },
    approval: { type: approvalSchema, default: () => ({}) },
    refs: { type: refsSchema, default: () => ({}) },
    correlationId: { type: String, trim: true, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed },
    occurredAt: { type: Date, required: true, index: true },
    source: {
      type: String,
      enum: Object.values(ORDER_EVENT_SOURCE),
      default: ORDER_EVENT_SOURCE.LIVE,
    },
  },
  { timestamps: true }
);

orderEventSchema.index({ orderDomain: 1, orderId: 1, occurredAt: -1 });
orderEventSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
orderEventSchema.index({ eventType: 1, occurredAt: -1 }, { sparse: true });

const immutableOps = [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "findByIdAndUpdate",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
  "findByIdAndDelete",
];
immutableOps.forEach((op) => {
  orderEventSchema.pre(op, function (next) {
    next(new Error("Order events are immutable. Emit a compensating event instead."));
  });
});

const OrderEvent =
  mongoose.models.OrderEvent || mongoose.model("OrderEvent", orderEventSchema);

export default OrderEvent;
