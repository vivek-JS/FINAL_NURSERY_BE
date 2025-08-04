import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import Order from "../models/order.model.js";
import DealerWallet from "../models/dealerWallet.js";
import PlantSlot from "../models/slots.model.js";

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
    const availableInWallet = entry.quantity - entry.bookedQuantity;
    
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

    return {
      fromWallet: requestedQuantity,
      fromSlot: 0,
      success: true
    };
  } catch (error) {
    console.error("Error allocating dealer quota:", error);
    throw error;
  }
};

// Function to restore dealer quota when order is rejected
export const restoreDealerQuota = async (orderId, session) => {
  try {
    const order = await Order.findById(orderId).session(session);
    
    if (!order || !order.dealerOrder || order.quotaRestored) {
      return { success: false, message: "Order not found or quota already restored" };
    }

    if (order.quotaUsed === 0) {
      return { success: true, message: "No quota to restore" };
    }

    // Use atomic update to avoid write conflicts
    // Also update remainingQuantity since pre-save middleware doesn't run with findOneAndUpdate
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

    // Mark order as quota restored
    order.quotaRestored = true;
    await order.save({ session });

    return { 
      success: true, 
      message: `Restored ${order.quotaUsed} plants to dealer quota`,
      restoredQuantity: order.quotaUsed
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