import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import Order from "../models/order.model.js";
import DealerWallet from "../models/dealerWallet.js";
import PlantSlot from "../models/slots.model.js";
import DealerPlantInventoryLedger from "../models/dealerPlantInventoryLedger.model.js";
import { getDealerQuotaLineAvailability } from "../utils/dealerWalletReconcile.js";

// Function to validate dealer quota before order creation (order-derived availability, same as wallet overlay)
export const validateDealerQuota = async (dealerId, plantType, subType, bookingSlot, requestedQuantity) => {
  try {
    const r = await getDealerQuotaLineAvailability(dealerId, plantType, subType, bookingSlot);
    if (!r.ok) {
      return {
        isValid: false,
        message: r.message,
        availableQuota: 0,
        allocation: { fromWallet: 0, fromSlot: requestedQuantity },
      };
    }

    const totalAvailable = r.availableForFarmerOrders;

    if (totalAvailable >= requestedQuantity) {
      const fromWallet = Math.min(totalAvailable, requestedQuantity);
      const fromSlot = requestedQuantity - fromWallet;

      return {
        isValid: true,
        message: "Quota validation successful",
        availableQuota: totalAvailable,
        allocation: { fromWallet, fromSlot },
      };
    }

    return {
      isValid: false,
      message: `Insufficient quota. Available: ${totalAvailable}, Requested: ${requestedQuantity}`,
      availableQuota: totalAvailable,
      allocation: { fromWallet: 0, fromSlot: requestedQuantity },
    };
  } catch (error) {
    console.error("Error validating dealer quota:", error);
    return {
      isValid: false,
      message: "Error validating quota",
      availableQuota: 0,
      allocation: { fromWallet: 0, fromSlot: requestedQuantity },
    };
  }
};

// Function to allocate dealer quota (order-derived baseline + $set; aligns with wallet reconcile)
export const allocateDealerQuota = async (dealerId, plantType, subType, bookingSlot, requestedQuantity, session) => {
  try {
    const r = await getDealerQuotaLineAvailability(dealerId, plantType, subType, bookingSlot, { session });

    if (!r.ok) {
      throw new AppError(r.message, r.reason === "no_wallet" ? 404 : 400);
    }

    const {
      wallet,
      entry,
      entryIndex,
      fixedQty,
      farmerBookedFromOrders,
      availableForFarmerOrders,
    } = r;

    const balanceBefore = availableForFarmerOrders;

    console.log("🔍 Allocating quota from entry (order-derived):", {
      entryId: entry._id?.toString(),
      plantType: entry.plantType?.toString(),
      subType: entry.subType?.toString(),
      bookingSlot: entry.bookingSlot?.toString(),
      fixedQty,
      farmerBookedFromOrders,
      availableForFarmerOrders,
      requestedQuantity,
    });

    if (availableForFarmerOrders < requestedQuantity) {
      throw new AppError(
        `Insufficient quota. Available: ${availableForFarmerOrders}, Requested: ${requestedQuantity}`,
        400
      );
    }

    const newBooked = farmerBookedFromOrders + requestedQuantity;
    const newRem = fixedQty - newBooked;
    const balanceAfter = availableForFarmerOrders - requestedQuantity;

    const result = await DealerWallet.findOneAndUpdate(
      { _id: wallet._id },
      {
        $set: {
          [`entries.${entryIndex}.quantity`]: fixedQty,
          [`entries.${entryIndex}.bookedQuantity`]: newBooked,
          [`entries.${entryIndex}.remainingQuantity`]: newRem,
        },
      },
      {
        session,
        new: true,
        runValidators: true,
      }
    );

    if (!result) {
      throw new AppError("Failed to update dealer quota", 500);
    }

    console.log("✅ Quota allocated, returning:", {
      fromWallet: requestedQuantity,
      fromSlot: 0,
      walletEntryId: entry._id?.toString(),
      success: true,
    });

    return {
      fromWallet: requestedQuantity,
      fromSlot: 0,
      walletEntryId: entry._id,
      success: true,
      ledgerParams: {
        transactionType: "INVENTORY_BOOK",
        dealer: dealerId,
        plantType,
        subType,
        bookingSlot,
        quantity: -requestedQuantity,
        balanceBefore,
        balanceAfter,
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