import { Schema, model } from "mongoose";
import { addPaymentToLedgerEntry } from "../utils/dealerLedgerHelper.js";

// Entry schema for individual quota allocations
const entrySchema = new Schema({
  plantType: {
    type: Schema.Types.ObjectId,
    ref: "PlantCms",
    required: true,
  },
  subType: {
    type: Schema.Types.ObjectId,
    required: true,
  },
  bookingSlot: {
    type: Schema.Types.ObjectId,
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    default: 0,
  },
  bookedQuantity: {
    type: Number,
    default: 0,
  },
  remainingQuantity: {
    type: Number,
    default: 0,
  },
});

// Transaction schema for wallet history
const transactionSchema = new Schema(
  {
    type: {
      type: String,
      enum: ["CREDIT", "DEBIT", "ORDER_PAYMENT", "PAYMENT_STATUS_UPDATE", "ADJUSTMENT"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    balanceBefore: {
      type: Number,
      required: true,
    },
    balanceAfter: {
      type: Number,
      required: true,
    },
    performedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    relatedOrder: {
      type: Schema.Types.ObjectId,
      ref: "Order",
    },
    /** Business reason: ORDER_PAYMENT, COMMISSION_SETTLEMENT, ADJUSTMENT, etc. */
    reason: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

const dealerWalletSchema = new Schema(
  {
    dealer: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    availableAmount: {
      type: Number,
      default: 0,
    },
    entries: [entrySchema],
    transactions: [transactionSchema],
  },
  { timestamps: true }
);

// Indexes for better performance
dealerWalletSchema.index({ dealer: 1 });
dealerWalletSchema.index({ "entries.plantType": 1 });
dealerWalletSchema.index({ "entries.bookingSlot": 1 });

// Pre-save middleware to calculate remainingQuantity
dealerWalletSchema.pre("save", function (next) {
  if (this.entries) {
    this.entries.forEach((entry) => {
      entry.remainingQuantity = entry.quantity - entry.bookedQuantity;
    });
  }
  next();
});

// Static method to add payment/transaction
dealerWalletSchema.statics.addPayment = async function (
  dealerId,
  amount,
  description = "Wallet transaction",
  performedBy = null,
  type = "ADJUSTMENT",
  relatedOrder = null,
  session = null,
  metadata = {}
) {
  try {
    let query = this.findOne({ dealer: dealerId });
    if (session) query = query.session(session);
    let wallet = await query;

    if (!wallet) {
      // Create new wallet if it doesn't exist
      wallet = new this({
        dealer: dealerId,
        availableAmount: amount,
        entries: [],
        transactions: [],
      });
    }

    const balanceBefore = wallet.availableAmount;
    const balanceAfter = balanceBefore + amount;

    // Add transaction record (embedded - legacy)
    const transaction = {
      type: amount >= 0 ? "CREDIT" : "DEBIT",
      amount: Math.abs(amount),
      description,
      balanceBefore,
      balanceAfter,
      performedBy,
      relatedOrder,
      reason: type || (amount >= 0 ? "CREDIT" : "DEBIT"),
    };

    wallet.transactions.push(transaction);
    wallet.availableAmount = balanceAfter;

    const saveOptions = session ? { session } : {};
    await wallet.save(saveOptions);

    // Write to immutable DealerLedgerEntry collection for audit
    try {
      await addPaymentToLedgerEntry({
        dealerId,
        amount,
        description,
        performedBy,
        type,
        relatedOrder,
        balanceBefore,
        balanceAfter,
        metadata,
        session,
      });
    } catch (ledgerError) {
      console.error("Error writing to dealer ledger (wallet updated):", ledgerError);
      // Don't fail the main operation; ledger write is best-effort audit
    }

    return transaction;
  } catch (error) {
    console.error("Error adding payment to dealer wallet:", error);
    throw error;
  }
};

// Static method for debugging wallet state
dealerWalletSchema.statics.debugWallet = async function (dealerId) {
  try {
    const wallet = await this.findOne({ dealer: dealerId });
    
    if (!wallet) {
      console.log(`No wallet found for dealer: ${dealerId}`);
      return;
    }

    console.log("=== Dealer Wallet Debug ===");
    console.log("Dealer ID:", dealerId);
    console.log("Available Amount:", wallet.availableAmount);
    console.log("Total Entries:", wallet.entries?.length || 0);
    console.log("Total Transactions:", wallet.transactions?.length || 0);
    
    if (wallet.transactions?.length > 0) {
      const lastTransaction = wallet.transactions[wallet.transactions.length - 1];
      console.log("Last Transaction:");
      console.log("  - Type:", lastTransaction.type);
      console.log("  - Amount:", lastTransaction.amount);
      console.log("  - Description:", lastTransaction.description);
      console.log("  - Balance After:", lastTransaction.balanceAfter);
    }
    
    console.log("=========================");
  } catch (error) {
    console.error("Error debugging wallet:", error);
  }
};

const DealerWallet = model("DealerWallet", dealerWalletSchema);

export default DealerWallet;
