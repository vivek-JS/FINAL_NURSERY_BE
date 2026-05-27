import mongoose from "mongoose";
import { VOUCHER_STATUS, VOUCHER_TYPES } from "../../domain/constants.js";

const financeVoucherSchema = new mongoose.Schema(
  {
    tenantId: { type: String, default: "default", index: true },
    voucherNo: { type: String, required: true, trim: true },
    voucherType: {
      type: String,
      enum: Object.values(VOUCHER_TYPES),
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(VOUCHER_STATUS),
      default: VOUCHER_STATUS.DRAFT,
    },
    branchId: { type: String, default: "default", index: true },
    entryDate: { type: Date, required: true, index: true },
    partyType: { type: String, trim: true },
    partyId: { type: String, trim: true },
    amountTotal: { type: Number, default: 0 },
    sourceDomain: { type: String, trim: true },
    sourceRefs: [{ type: String }],
    description: { type: String, trim: true },
    postedJournalId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry" },
    reversalVoucherId: { type: mongoose.Schema.Types.ObjectId, ref: "FinanceVoucher" },
    financialEventId: { type: mongoose.Schema.Types.ObjectId, ref: "FinancialEvent" },
    metadata: { type: mongoose.Schema.Types.Mixed },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

financeVoucherSchema.index({ tenantId: 1, voucherNo: 1 }, { unique: true });
financeVoucherSchema.index({ tenantId: 1, status: 1, entryDate: -1 });

const FinanceVoucher =
  mongoose.models.FinanceVoucher ||
  mongoose.model("FinanceVoucher", financeVoucherSchema);

export default FinanceVoucher;
