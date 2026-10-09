import mongoose, { Schema } from "mongoose";

/**
 * icici_payouts — outgoing payments made through the ICICI CIB Transaction API.
 *
 * Three people must agree before money moves:
 *   maker (ERP) → checker (ERP, a different user) → authoriser (ICICI net banking)
 *
 * Lifecycle:
 *   PENDING_APPROVAL → REJECTED | CANCELLED
 *   PENDING_APPROVAL → SUBMITTING → AWAITING_BANK_APPROVAL → PROCESSING → SUCCESS
 *                                 ↘ FAILED | UNKNOWN (no answer; status is polled)
 *   SUCCESS → REVERSED (RTGS/NEFT returned)
 */
export const PAYOUT_STATUSES = [
  "PENDING_APPROVAL",
  "REJECTED",
  "CANCELLED",
  "SUBMITTING",
  "AWAITING_BANK_APPROVAL",
  "PROCESSING",
  "UNKNOWN",
  "SUCCESS",
  "FAILED",
  "REVERSED",
];

export const PAYOUT_TERMINAL = new Set(["REJECTED", "CANCELLED", "SUCCESS", "FAILED", "REVERSED"]);

export const PAYOUT_TXN_TYPES = ["RGS", "RTG", "IFS", "TPA"];

export const PAYOUT_PURPOSES = [
  "VENDOR_BILL",
  "FARMER_REFUND",
  "DEALER_COMMISSION",
  "SALARY",
  "ADVANCE",
  "OTHER",
];

const historySchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    action: { type: String, required: true },
    fromStatus: { type: String },
    toStatus: { type: String },
    by: { type: Schema.Types.ObjectId, ref: "User" },
    byName: { type: String },
    note: { type: String },
  },
  { _id: false }
);

const iciciPayoutSchema = new Schema(
  {
    /** Sent to ICICI as UNIQUEID. The first 15 characters appear in the statement narration. */
    uniqueId: { type: String, required: true, unique: true },
    status: { type: String, enum: PAYOUT_STATUSES, default: "PENDING_APPROVAL", index: true },

    payee: {
      name: { type: String, required: true, trim: true },
      accountNumber: { type: String, required: true, trim: true },
      ifsc: { type: String, required: true, trim: true, uppercase: true },
      bankName: { type: String, trim: true },
      type: {
        type: String,
        enum: ["VENDOR", "FARMER", "DEALER", "EMPLOYEE", "OTHER"],
        default: "VENDOR",
      },
    },
    /** Set when paid to a payee from the approved register; empty for a one-time payee. */
    beneficiaryId: { type: Schema.Types.ObjectId, ref: "IciciBeneficiary", index: true },
    amount: { type: Number, required: true, min: 0.01 },
    currency: { type: String, default: "INR" },
    txnType: { type: String, enum: PAYOUT_TXN_TYPES, required: true },
    debitAccount: { type: String, required: true, trim: true },
    remarks: { type: String, trim: true, default: "" },
    purpose: { type: String, enum: PAYOUT_PURPOSES, default: "OTHER" },
    /** Bill, invoice or order number this payment settles. */
    referenceNo: { type: String, trim: true, default: "" },

    makerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    makerName: { type: String },
    checkerId: { type: Schema.Types.ObjectId, ref: "User" },
    checkerName: { type: String },
    checkedAt: { type: Date },
    checkerNote: { type: String },
    rejectReason: { type: String },

    bank: {
      stub: { type: Boolean, default: false },
      reqId: { type: String },
      utr: { type: String, index: true },
      status: { type: String },
      response: { type: String },
      errorCode: { type: String },
      message: { type: String },
      submittedAt: { type: Date },
      lastCheckedAt: { type: Date },
      completedAt: { type: Date },
      checks: { type: Number, default: 0 },
    },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true, collection: "icici_payouts" }
);

iciciPayoutSchema.index({ status: 1, "bank.lastCheckedAt": 1 });
iciciPayoutSchema.index({ "payee.accountNumber": 1, amount: 1, createdAt: -1 });

const IciciPayout =
  mongoose.models.IciciPayout || mongoose.model("IciciPayout", iciciPayoutSchema);

export default IciciPayout;
