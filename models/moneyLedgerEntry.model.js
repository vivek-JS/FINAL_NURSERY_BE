import mongoose from "mongoose";

/**
 * Append-only money ledger for Biotech AR/AP and Ram Agri AP.
 * Ram Agri customer AR stays on RamAgriCustomerLedgerEntry.
 *
 * AR: debit ↑ they owe, credit ↓ (payment / sale return)
 * AP: credit ↑ we owe, debit ↓ (payment / purchase return)
 */
const moneyLedgerEntrySchema = new mongoose.Schema(
  {
    book: {
      type: String,
      enum: ["BIOTECH", "RAM_AGRI"],
      required: true,
      index: true,
    },
    side: {
      type: String,
      enum: ["AR", "AP"],
      required: true,
      index: true,
    },
    partyType: {
      type: String,
      enum: ["SUPPLIER", "MERCHANT", "FARMER", "CUSTOMER"],
      required: true,
      index: true,
    },
    partyId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    partyName: { type: String, trim: true, default: "" },
    partyKey: { type: String, trim: true, index: true },
    entryDate: { type: Date, required: true, index: true, default: Date.now },
    refType: {
      type: String,
      enum: [
        "PURCHASE",
        "SELL",
        "PAYMENT",
        "SALES_RETURN",
        "PURCHASE_RETURN",
        "DISCOUNT",
        "ADJUSTMENT",
        "REVERSAL",
      ],
      required: true,
      index: true,
    },
    refId: { type: mongoose.Schema.Types.ObjectId },
    documentType: {
      type: String,
      enum: [
        "PurchaseOrder",
        "GRN",
        "PurchaseReturn",
        "SellOrder",
        "AgriSalesOrder",
        "Manual",
        "Other",
      ],
      default: "Other",
    },
    documentId: { type: mongoose.Schema.Types.ObjectId, index: true },
    documentNumber: { type: String, trim: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    description: { type: String, trim: true, default: "" },
    reference: { type: String, trim: true, default: "" },
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

moneyLedgerEntrySchema.index({ book: 1, side: 1, partyType: 1, partyId: 1, entryDate: 1 });
moneyLedgerEntrySchema.index({ book: 1, documentType: 1, documentId: 1 });

moneyLedgerEntrySchema.pre("validate", function (next) {
  const debit = Number(this.debit || 0);
  const credit = Number(this.credit || 0);
  if (debit <= 0 && credit <= 0) {
    return next(new Error("Ledger entry must have a debit or credit amount"));
  }
  if (debit > 0 && credit > 0) {
    return next(new Error("Ledger entry cannot have both debit and credit"));
  }
  next();
});

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
  moneyLedgerEntrySchema.pre(op, function (next) {
    next(new Error("Money ledger entries are immutable. Post a reversal instead."));
  });
});

const MoneyLedgerEntry = mongoose.model("MoneyLedgerEntry", moneyLedgerEntrySchema);
export default MoneyLedgerEntry;
