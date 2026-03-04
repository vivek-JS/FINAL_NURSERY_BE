import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import Order from "../models/order.model.js";
import DealerWallet from "../models/dealerWallet.js";
import PlantSlot from "../models/slots.model.js";
import DealerPlantInventoryLedger from "../models/dealerPlantInventoryLedger.model.js";

// Function to validate dealer quota before order creation
export const validateDealerQuota = async (dealerId, plantType, subType, bookingSlot, requestedQuantity) => {
  try {
    // Check dealer wallet
    const wallet = await DealerWallet.findOne({ dealer: dealerId });
    
    if (!wallet) {
      return {
        isValid: false,
        message: "Dealer has no quota allocation",
        availableQuota: 0,
        allocation: { fromWallet: 0, fromSlot: requestedQuantity }
      };
    }

    // Find exact matching entry
    const entry = wallet.entries.find(
      (e) =>
        e.plantType?.equals(plantType) &&
        e.subType?.equals(subType) &&
        e.bookingSlot?.equals(bookingSlot)
    );

    if (!entry) {
      return {
        isValid: false,
        message: "No quota allocation found for this plant/subtype/slot combination",
        availableQuota: 0,
        allocation: { fromWallet: 0, fromSlot: requestedQuantity }
      };
    }

    const availableInWallet = entry.quantity - entry.bookedQuantity;
    const totalAvailable = availableInWallet;

    if (totalAvailable >= requestedQuantity) {
      // Can fulfill from quota
      const fromWallet = Math.min(availableInWallet, requestedQuantity);
      const fromSlot = requestedQuantity - fromWallet;

      return {
        isValid: true,
        message: "Quota validation successful",
        availableQuota: totalAvailable,
        allocation: { fromWallet, fromSlot }
      };
    } else {
      // Cannot fulfill from quota
      return {
        isValid: false,
        message: `Insufficient quota. Available: ${totalAvailable}, Requested: ${requestedQuantity}`,
        availableQuota: totalAvailable,
        allocation: { fromWallet: 0, fromSlot: requestedQuantity }
      };
    }
  } catch (error) {
    console.error("Error validating dealer quota:", error);
    return {
      isValid: false,
      message: "Error validating quota",
      availableQuota: 0,
      allocation: { fromWallet: 0, fromSlot: requestedQuantity }
    };
  }
};

// Function to allocate dealer quota
export const allocateDealerQuota = async (dealerId, plantType, subType, bookingSlot, requestedQuantity, session) => {
  try {
    // First, find the wallet and validate quota
    const wallet = await DealerWallet.findOne({ dealer: dealerId }).session(session);
    
    if (!wallet) {
      throw new AppError("Dealer wallet not found", 404);
    }

    // Find exact matching entry
    const entryIndex = wallet.entries.findIndex(
      (e) =>
        e.plantType?.equals(plantType) &&
        e.subType?.equals(subType) &&
        e.bookingSlot?.equals(bookingSlot)
    );

    if (entryIndex === -1) {
      throw new AppError("No quota allocation found for this combination", 404);
    }

    const entry = wallet.entries[entryIndex];
    const entryId = entry._id;
    const availableInWallet = entry.quantity - entry.bookedQuantity;
    
    console.log('🔍 Allocating quota from entry:', {
      entryId: entryId?.toString(),
      plantType: entry.plantType?.toString(),
      subType: entry.subType?.toString(),
      bookingSlot: entry.bookingSlot?.toString(),
      availableInWallet,
      requestedQuantity
    });
    
    if (availableInWallet < requestedQuantity) {
      throw new AppError(`Insufficient quota. Available: ${availableInWallet}, Requested: ${requestedQuantity}`, 400);
    }

    // Use atomic update to avoid write conflicts
    // Also update remainingQuantity since pre-save middleware doesn't run with findOneAndUpdate
    const result = await DealerWallet.findOneAndUpdate(
      {
        _id: wallet._id,
        [`entries.${entryIndex}.bookedQuantity`]: { $exists: true }
      },
      {
        $inc: {
          [`entries.${entryIndex}.bookedQuantity`]: requestedQuantity,
          [`entries.${entryIndex}.remainingQuantity`]: -requestedQuantity
        }
      },
      {
        session,
        new: true,
        runValidators: true
      }
    );

    if (!result) {
      throw new AppError("Failed to update dealer quota", 500);
    }

    console.log('✅ Quota allocated, returning:', {
      fromWallet: requestedQuantity,
      fromSlot: 0,
      walletEntryId: entryId?.toString(),
      success: true
    });

    return {
      fromWallet: requestedQuantity,
      fromSlot: 0,
      walletEntryId: entryId, // Return the wallet entry ID
      success: true,
      ledgerParams: {
        transactionType: "INVENTORY_BOOK",
        dealer: dealerId,
        plantType,
        subType,
        bookingSlot,
        quantity: -requestedQuantity, // Negative = reduces available
        balanceBefore: availableInWallet,
        balanceAfter: availableInWallet - requestedQuantity,
        description: `Farmer order from dealer quota: -${requestedQuantity} plants`,
      },
    };
  } catch (error) {
    console.error("Error allocating dealer quota:", error);
    throw error;
  }
};

// Function to restore dealer quota when order is rejected or cancelled
export const restoreDealerQuota = async (orderId, session, performedBy = null, reason = "rejected") => {
  try {
    const order = await Order.findById(orderId).populate("farmer", "name").populate("plantName", "name").session(session);
    
    if (!order || !order.dealerOrder || order.quotaRestored) {
      return { success: false, message: "Order not found or quota already restored" };
    }

    // Dealer bulk orders (dealerOrder: true) created via factory don't set quotaUsed; they use numberOfPlants in wallet.
    // Use numberOfPlants when quotaUsed is 0 so we still create the ledger entry. Wallet update is done by factory's automatic block.
    const quantityToRestore = order.quotaUsed > 0 ? order.quotaUsed : (order.numberOfPlants || 0);
    if (quantityToRestore === 0) {
      return { success: true, message: "No quota to restore" };
    }

    // Get current entry state for ledger before update
    const wallet = await DealerWallet.findOne({
      dealer: order.dealer,
      "entries.plantType": order.plantName,
      "entries.subType": order.plantSubtype,
      "entries.bookingSlot": order.bookingSlot
    }).session(session);

    const entry = wallet?.entries?.find(
      (e) =>
        e.plantType?.equals(order.plantName) &&
        e.subType?.equals(order.plantSubtype) &&
        e.bookingSlot?.equals(order.bookingSlot)
    );
    const balanceBefore = entry ? entry.quantity - entry.bookedQuantity : 0;
    const balanceAfter = balanceBefore + quantityToRestore;

    // Only update wallet when quotaUsed was set (farmer orders via dealer quota). Dealer bulk orders (quotaUsed === 0)
    // have their wallet updated by the factory's automatic dealer quota block, so skip to avoid double update.
    if (order.quotaUsed > 0) {
      const result = await DealerWallet.findOneAndUpdate(
        {
          dealer: order.dealer,
          "entries.plantType": order.plantName,
          "entries.subType": order.plantSubtype,
          "entries.bookingSlot": order.bookingSlot
        },
        {
          $inc: {
            "entries.$.bookedQuantity": -order.quotaUsed,
            "entries.$.remainingQuantity": order.quotaUsed
          }
        },
        {
          session,
          new: true,
          runValidators: true
        }
      );

      if (!result) {
        return { success: false, message: "Quota entry not found or could not be updated" };
      }
    }

    // Create ledger entry (INVENTORY_RELEASE). Dealer bulk orders (quotaUsed === 0) get ledger from factory; only create here for farmer orders via dealer quota.
    if (order.quotaUsed > 0) {
      try {
        const actionLabel = reason === "cancelled" ? "cancelled" : "rejected";
        const orderIdDisplay = order.orderId ?? order._id?.toString?.() ?? "";
        const farmerName = order.farmer?.name ?? (order.dealerOrder ? "Dealer order" : "—");
        const plantNameDisplay = order.plantName?.name ?? "Plant";
        const releaseDescription = `Release added to dealer quota. Order ID: ${orderIdDisplay}, Farmer: ${farmerName}, Plant: ${plantNameDisplay}, Qty: ${quantityToRestore}, Reason: Order ${actionLabel}.`;
        await DealerPlantInventoryLedger.createLedgerEntry(
          {
            transactionType: "INVENTORY_RELEASE",
            dealer: order.dealer,
            plantType: order.plantName?._id ?? order.plantName,
            subType: order.plantSubtype,
            bookingSlot: order.bookingSlot,
            quantity: quantityToRestore,
            balanceBefore,
            balanceAfter,
            referenceId: order._id,
            description: releaseDescription,
            performedBy,
          },
          session
        );
      } catch (ledgerErr) {
        console.error("DealerPlantInventoryLedger INVENTORY_RELEASE failed:", ledgerErr);
      }
    }

    // Mark order as quota restored
    order.quotaRestored = true;
    await order.save({ session });

    return { 
      success: true, 
      message: `Restored ${quantityToRestore} plants to dealer quota`,
      restoredQuantity: quantityToRestore
    };
  } catch (error) {
    console.error("Error restoring dealer quota:", error);
    throw error;
  }
};

// Function to get dealer quota summary
export const getDealerQuotaSummary = async (dealerId) => {
  try {
    const wallet = await DealerWallet.findOne({ dealer: dealerId });
    
    if (!wallet) {
      return { totalQuota: 0, usedQuota: 0, availableQuota: 0, entries: [] };
    }

    const summary = {
      totalQuota: 0,
      usedQuota: 0,
      availableQuota: 0,
      entries: []
    };

    wallet.entries.forEach(entry => {
      const total = entry.quantity || 0;
      const used = entry.bookedQuantity || 0;
      const available = total - used;

      summary.totalQuota += total;
      summary.usedQuota += used;
      summary.availableQuota += available;

      summary.entries.push({
        plantType: entry.plantType,
        subType: entry.subType,
        bookingSlot: entry.bookingSlot,
        total: total,
        used: used,
        available: available
      });
    });

    return summary;
  } catch (error) {
    console.error("Error getting dealer quota summary:", error);
    throw error;
  }
};

// Function to check if order can be rejected (quota restoration)
export const canRejectOrder = async (orderId) => {
  try {
    const order = await Order.findById(orderId);
    
    if (!order) {
      return { canReject: false, message: "Order not found" };
    }

    if (!order.dealerOrder) {
      return { canReject: true, message: "Not a dealer order" };
    }

    if (order.quotaRestored) {
      return { canReject: true, message: "Quota already restored" };
    }

    if (order.quotaUsed === 0) {
      return { canReject: true, message: "No quota to restore" };
    }

    return { canReject: true, message: "Can reject and restore quota" };
  } catch (error) {
    console.error("Error checking if order can be rejected:", error);
    return { canReject: false, message: "Error checking order" };
  }
}; 