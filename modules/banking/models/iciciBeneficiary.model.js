import mongoose, { Schema } from "mongoose";

/**
 * icici_beneficiaries — the ERP's register of approved payees for payouts.
 *
 * A payee is added by a maker and approved by a different checker before any
 * payout can use it:
 *   PENDING_APPROVAL → ACTIVE | REJECTED
 *   ACTIVE → DISABLED
 *
 * The CIB payment API is ad hoc (no bank-side registration), so this register
 * lives in the ERP; bankKind records whether the payee banks with ICICI.
 */
export const BENEFICIARY_STATUSES = ["PENDING_APPROVAL", "ACTIVE", "REJECTED", "DISABLED"];
export const BENEFICIARY_BANK_KINDS = ["ICICI", "NON_ICICI"];
export const PAYEE_TYPES = ["VENDOR", "FARMER", "DEALER", "EMPLOYEE", "OTHER"];

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

const iciciBeneficiarySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    nickname: { type: String, trim: true, default: "" },
    accountNumber: { type: String, required: true, trim: true },
    ifsc: { type: String, required: true, trim: true, uppercase: true },
    bankName: { type: String, trim: true, default: "" },
    bankKind: { type: String, enum: BENEFICIARY_BANK_KINDS, required: true },
    type: { type: String, enum: PAYEE_TYPES, default: "VENDOR" },
    mobile: { type: String, trim: true, default: "" },
    status: { type: String, enum: BENEFICIARY_STATUSES, default: "PENDING_APPROVAL", index: true },

    /** `account|ifsc` while PENDING_APPROVAL or ACTIVE; unset otherwise, so a rejected payee can be re-added. */
    dedupeKey: { type: String },

    makerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    makerName: { type: String },
    checkerId: { type: Schema.Types.ObjectId, ref: "User" },
    checkerName: { type: String },
    checkedAt: { type: Date },
    rejectReason: { type: String },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true, collection: "icici_beneficiaries" }
);

iciciBeneficiarySchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });
iciciBeneficiarySchema.index({ accountNumber: 1 });

const IciciBeneficiary =
  mongoose.models.IciciBeneficiary || mongoose.model("IciciBeneficiary", iciciBeneficiarySchema);

export default IciciBeneficiary;
