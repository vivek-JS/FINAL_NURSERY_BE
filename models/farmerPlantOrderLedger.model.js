import mongoose from "mongoose";

/**
 * Farmer plant order ledger — append-only audit mirror for normal (non-dealer) plant orders.
 * Separate from Ram Agri customer ledger and dealer ledgers.
 */
const farmerPlantOrderLedgerSchema = new mongoose.Schema(
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
    farmer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Farmer",
      index: true,
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
      ref: "Order",
      required: true,
      index: true,
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
    /** Running receivable before this line (+ = farmer owes, − = advance). Set at insert. */
    outstandingBefore: {
      type: Number,
    },
    /** Running receivable after this line. */
    outstandingAfter: {
      type: Number,
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

farmerPlantOrderLedgerSchema.index({ customerMobile: 1, entryDate: 1 });
farmerPlantOrderLedgerSchema.index({ farmer: 1, entryDate: 1 });
farmerPlantOrderLedgerSchema.index({ orderId: 1, entryDate: 1 });
farmerPlantOrderLedgerSchema.index(
  { orderId: 1, "metadata.transitionKey": 1 },
  { unique: true, sparse: true }
);
/** At most one ORDER debit per plant order (append-only; prevents duplicate full debits). */
farmerPlantOrderLedgerSchema.index(
  { orderId: 1 },
  {
    unique: true,
    partialFilterExpression: { refType: "ORDER" },
    name: "uniq_farmer_plant_ledger_order_debit",
  }
);

farmerPlantOrderLedgerSchema.pre("validate", function (next) {
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
  farmerPlantOrderLedgerSchema.pre(operation, function (next) {
    next(new Error("Farmer plant ledger entries are immutable. Create a reversal entry instead."));
  });
});

const FarmerPlantOrderLedgerEntry = mongoose.model(
  "FarmerPlantOrderLedgerEntry",
  farmerPlantOrderLedgerSchema
);

export default FarmerPlantOrderLedgerEntry;
