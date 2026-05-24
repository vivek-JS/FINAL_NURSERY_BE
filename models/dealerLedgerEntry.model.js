import mongoose from "mongoose";

const dealerLedgerEntrySchema = new mongoose.Schema(
  {
    dealer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    entryDate: {
      type: Date,
      required: true,
      index: true,
    },
    refType: {
      type: String,
      enum: [
        "ORDER_BOOKING",
        "ORDER_RECEIVABLE_PAYMENT",
        "ORDER_PAYMENT",
        "PAYMENT_STATUS_UPDATE",
        "ADJUSTMENT",
        "REVERSAL",
        "MANUAL_CREDIT",
        "MANUAL_DEBIT",
        "COMMISSION_SETTLEMENT",
      ],
      required: true,
    },
    refId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
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
    balanceBefore: {
      type: Number,
    },
    balanceAfter: {
      type: Number,
    },
    reference: {
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
    reversalOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DealerLedgerEntry",
    },
  },
  { timestamps: true }
);

dealerLedgerEntrySchema.index({ dealer: 1, entryDate: 1 });
dealerLedgerEntrySchema.index({ orderId: 1 });

dealerLedgerEntrySchema.pre("validate", function (next) {
  const debit = Number(this.debit || 0);
  const credit = Number(this.credit || 0);
  if (this.refType === "ORDER_BOOKING") {
    if (credit > 0) {
      return next(new Error("ORDER_BOOKING must be a debit-only receivable line"));
    }
    if (debit <= 0) {
      return next(new Error("ORDER_BOOKING must have a debit amount for order outstanding"));
    }
    return next();
  }
  if (this.refType === "ORDER_RECEIVABLE_PAYMENT") {
    if (debit > 0) {
      return next(new Error("ORDER_RECEIVABLE_PAYMENT must be credit-only"));
    }
    if (credit <= 0) {
      return next(new Error("ORDER_RECEIVABLE_PAYMENT must have a credit amount"));
    }
    return next();
  }
  if (debit <= 0 && credit <= 0) {
    return next(new Error("Dealer ledger entry must have a debit or credit amount"));
  }
  if (debit > 0 && credit > 0) {
    return next(new Error("Dealer ledger entry cannot have both debit and credit"));
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
  dealerLedgerEntrySchema.pre(operation, function (next) {
    next(
      new Error(
        "Dealer ledger entries are immutable. Create a reversal/correction entry instead."
      )
    );
  });
});

const DealerLedgerEntry = mongoose.model(
  "DealerLedgerEntry",
  dealerLedgerEntrySchema
);

export default DealerLedgerEntry;
