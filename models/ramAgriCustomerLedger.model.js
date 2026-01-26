import mongoose from "mongoose";

const ramAgriCustomerLedgerSchema = new mongoose.Schema(
  {
    customerMobile: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    customerName: {
      type: String,
      trim: true,
    },
    entryDate: {
      type: Date,
      required: true,
      index: true,
    },
    refType: {
      type: String,
      enum: ["ORDER", "PAYMENT", "ADJUSTMENT", "REVERSAL"],
      required: true,
    },
    refId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AgriSalesOrder",
    },
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    debit: {
      type: Number,
      default: 0,
      min: 0,
    },
    credit: {
      type: Number,
      default: 0,
      min: 0,
    },
    reference: {
      type: String,
      trim: true,
    },
    category: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

ramAgriCustomerLedgerSchema.index({ customerMobile: 1, entryDate: 1 });

ramAgriCustomerLedgerSchema.pre("validate", function (next) {
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

const immutableOperations = [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "findByIdAndUpdate",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
  "findByIdAndDelete",
];

immutableOperations.forEach((operation) => {
  ramAgriCustomerLedgerSchema.pre(operation, function (next) {
    next(new Error("Ledger entries are immutable. Create a reversal entry instead."));
  });
});

const RamAgriCustomerLedgerEntry = mongoose.model(
  "RamAgriCustomerLedgerEntry",
  ramAgriCustomerLedgerSchema
);

export default RamAgriCustomerLedgerEntry;
