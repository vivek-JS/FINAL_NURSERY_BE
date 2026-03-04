import mongoose from "mongoose";

/**
 * Dealer Plant Inventory Ledger
 * Immutable, append-only ledger for dealer quota (plant) movements.
 * Records: INVENTORY_ADD (dealer bulk order), INVENTORY_BOOK (farmer order from quota), INVENTORY_RELEASE (order rejected).
 */
const dealerPlantInventoryLedgerSchema = new mongoose.Schema(
  {
    transactionNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    dealer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    plantType: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PlantCms",
      required: true,
    },
    subType: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    bookingSlot: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    transactionType: {
      type: String,
      enum: ["INVENTORY_ADD", "INVENTORY_BOOK", "INVENTORY_RELEASE"],
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      // Positive for ADD/RELEASE, negative for BOOK (reduces available)
    },
    balanceBefore: {
      type: Number,
      required: true,
      // Available quantity (quantity - bookedQuantity) before this transaction
    },
    balanceAfter: {
      type: Number,
      required: true,
      // Available quantity after this transaction
    },
    referenceType: {
      type: String,
      enum: ["ORDER"],
      default: "ORDER",
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
    },
    description: {
      type: String,
      trim: true,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

dealerPlantInventoryLedgerSchema.index({ dealer: 1, createdAt: -1 });
dealerPlantInventoryLedgerSchema.index({ dealer: 1, plantType: 1, subType: 1 });
dealerPlantInventoryLedgerSchema.index({ referenceId: 1 });
dealerPlantInventoryLedgerSchema.index({ transactionNumber: 1 });

// Generate transaction number: PLT-YYYYMMDD-0001 (optional session for use inside transaction)
dealerPlantInventoryLedgerSchema.statics.generateTransactionNumber = async function (session = null) {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const prefix = `PLT-${yyyy}${mm}${dd}`;

  const q = this.findOne({ transactionNumber: new RegExp(`^${prefix}`) })
    .sort({ transactionNumber: -1 })
    .select("transactionNumber")
    .lean();
  if (session) q.session(session);
  const last = await q;

  let seq = 1;
  if (last?.transactionNumber) {
    const match = last.transactionNumber.match(/-(\d+)$/);
    if (match) seq = parseInt(match[1], 10) + 1;
  }

  return `${prefix}-${String(seq).padStart(4, "0")}`;
};

/**
 * Create a ledger entry (immutable, append-only).
 * @param {Object} params - dealer, plantType, subType, bookingSlot, transactionType, quantity, balanceBefore, balanceAfter, referenceId, description, performedBy
 */
dealerPlantInventoryLedgerSchema.statics.createLedgerEntry = async function (params, session = null) {
  const { dealer, plantType, subType, bookingSlot, transactionType, quantity, balanceBefore, balanceAfter, referenceId, description, performedBy } = params;
  const balanceAfterComputed = balanceAfter ?? balanceBefore + quantity;
  const transactionNumber = await this.generateTransactionNumber(session);
  const doc = await this.create(
    [
      {
        transactionNumber,
        dealer,
        plantType,
        subType,
        bookingSlot,
        transactionType,
        quantity,
        balanceBefore,
        balanceAfter: balanceAfterComputed,
        referenceType: "ORDER",
        referenceId: referenceId || null,
        description: description || "",
        performedBy: performedBy || null,
      },
    ],
    session ? { session } : {}
  );
  return doc[0];
};

const DealerPlantInventoryLedger = mongoose.model(
  "DealerPlantInventoryLedger",
  dealerPlantInventoryLedgerSchema
);

export default DealerPlantInventoryLedger;
