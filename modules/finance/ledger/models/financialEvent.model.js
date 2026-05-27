import mongoose from "mongoose";
import { EVENT_STATUS, FINANCIAL_EVENT_TYPES } from "../../domain/constants.js";

const financialEventSchema = new mongoose.Schema(
  {
    tenantId: { type: String, default: "default", index: true },
    idempotencyKey: { type: String, required: true, trim: true },
    eventType: {
      type: String,
      enum: Object.values(FINANCIAL_EVENT_TYPES),
      required: true,
    },
    sourceDomain: { type: String, required: true, trim: true },
    sourceId: { type: String, trim: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: Object.values(EVENT_STATUS),
      default: EVENT_STATUS.PENDING,
    },
    voucherId: { type: mongoose.Schema.Types.ObjectId, ref: "FinanceVoucher" },
    journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry" },
    errorMessage: { type: String },
    clientEventId: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    orderEventId: { type: mongoose.Schema.Types.ObjectId, ref: "OrderEvent" },
  },
  { timestamps: true }
);

financialEventSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
financialEventSchema.index({ status: 1, createdAt: -1 });

const FinancialEvent =
  mongoose.models.FinancialEvent ||
  mongoose.model("FinancialEvent", financialEventSchema);

export default FinancialEvent;
