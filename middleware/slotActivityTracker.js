import PlantSlot from '../models/slots.model.js';
import mongoose from 'mongoose';

/**
 * Middleware to track slot activities
 * This middleware ensures all slot operations are properly logged with complete information
 */

/**
 * Get activity name from action type
 */
const getActivityName = (action) => {
  const activityNameMap = {
    'ADD': 'Plants Added',
    'SUBTRACT': 'Plants Subtracted',
    'BUFFER_APPLIED': 'Buffer Applied',
    'BUFFER_RELEASED': 'Buffer Released',
    'ADD_WITH_BUFFER': 'Plants Added with Buffer',
    'ADD_WITH_BUFFER_RELEASE': 'Plants Added with Buffer Release',
    'SUBTRACT_WITH_BUFFER': 'Plants Subtracted with Buffer',
    'SUBTRACT_WITH_BUFFER_RELEASE': 'Plants Subtracted with Buffer Release',
    'UPDATE': 'Slot Updated',
    'ORDER_CANCELLED': 'Order Cancelled',
    'ORDER_RETURNED': 'Order Returned',
    'SOWING_STARTED': 'Sowing Started',
    'STOCK_REQUEST_ISSUED': 'Stock Request Issued',
    'SOWING_COMPLETED': 'Sowing Completed',
    'SOWING_CANCELLED': 'Sowing Cancelled',
    'SOWING_PRIMARY': 'Primary Location Sowing',
    'SOWING_OFFICE': 'Office Location Sowing',
    'SOWING_EXCESSIVE': 'Excessive Sowing',
    'EXCESSIVE_SOWING_ADDED': 'Excessive Sowing Added',
    'STOCK_REQUEST_CREATED': 'Stock Request Created',
    'STOCK_REQUEST_CANCELLED': 'Stock Request Cancelled',
    'GAP_COVERED': 'Gap Covered',
    'SOWING_IN_PROGRESS_CLEARED': 'Sowing In Progress Cleared',
    'PACKETS_RETURNED': 'Packets Returned',
    'PACKETS_USED': 'Packets Used',
  };

  return activityNameMap[action] || action.replace(/_/g, ' ');
};

/**
 * Ensure trail entry has all required fields with defaults
 */
const ensureTrailEntryComplete = (trailEntry, slot) => {
  return {
    // Core required fields
    action: trailEntry.action || 'UPDATE',
    activityName: trailEntry.activityName || getActivityName(trailEntry.action || 'UPDATE'),
    quantity: trailEntry.quantity ?? 0,
    reason: trailEntry.reason || 'Slot activity',
    notes: trailEntry.notes || '',
    
    // Plus values (what was added)
    plus: {
      primarySowed: trailEntry.plus?.primarySowed ?? 0,
      officeSowed: trailEntry.plus?.officeSowed ?? 0,
      totalPlants: trailEntry.plus?.totalPlants ?? 0,
      availablePlants: trailEntry.plus?.availablePlants ?? 0,
      excessivePlants: trailEntry.plus?.excessivePlants ?? 0,
      packetsUsed: trailEntry.plus?.packetsUsed ?? 0,
      plantsSowed: trailEntry.plus?.plantsSowed ?? 0,
      gapCovered: trailEntry.plus?.gapCovered ?? 0,
    },
    
    // Minus values (what was subtracted)
    minus: {
      packetsRemaining: trailEntry.minus?.packetsRemaining ?? 0,
      inProgressEntries: trailEntry.minus?.inProgressEntries ?? 0,
    },
    
    // Before state
    before: {
      primarySowed: trailEntry.before?.primarySowed ?? slot?.primarySowed ?? 0,
      officeSowed: trailEntry.before?.officeSowed ?? slot?.officeSowed ?? 0,
      totalPlants: trailEntry.before?.totalPlants ?? trailEntry.previousTotalPlants ?? slot?.totalPlants ?? 0,
      availablePlants: trailEntry.before?.availablePlants ?? trailEntry.previousAvailablePlants ?? slot?.availablePlants ?? 0,
      excessivePlants: trailEntry.before?.excessivePlants ?? slot?.excessiveSowing?.plants ?? 0,
      plantsSowed: trailEntry.before?.plantsSowed ?? slot?.plantsSowed ?? 0,
      totalBookedPlants: trailEntry.before?.totalBookedPlants ?? slot?.totalBookedPlants ?? 0,
      inProgressCount: trailEntry.before?.inProgressCount ?? slot?.sowingInProgress?.length ?? 0,
    },
    
    // After state
    after: {
      primarySowed: trailEntry.after?.primarySowed ?? slot?.primarySowed ?? 0,
      officeSowed: trailEntry.after?.officeSowed ?? slot?.officeSowed ?? 0,
      totalPlants: trailEntry.after?.totalPlants ?? trailEntry.newTotalPlants ?? slot?.totalPlants ?? 0,
      availablePlants: trailEntry.after?.availablePlants ?? trailEntry.newAvailablePlants ?? slot?.availablePlants ?? 0,
      excessivePlants: trailEntry.after?.excessivePlants ?? slot?.excessiveSowing?.plants ?? 0,
      plantsSowed: trailEntry.after?.plantsSowed ?? slot?.plantsSowed ?? 0,
      totalBookedPlants: trailEntry.after?.totalBookedPlants ?? slot?.totalBookedPlants ?? 0,
      inProgressCount: trailEntry.after?.inProgressCount ?? slot?.sowingInProgress?.length ?? 0,
    },
    
    // Legacy fields for backward compatibility
    previousTotalPlants: trailEntry.previousTotalPlants ?? trailEntry.before?.totalPlants ?? slot?.totalPlants ?? 0,
    newTotalPlants: trailEntry.newTotalPlants ?? trailEntry.after?.totalPlants ?? slot?.totalPlants ?? 0,
    previousAvailablePlants: trailEntry.previousAvailablePlants ?? trailEntry.before?.availablePlants ?? slot?.availablePlants ?? 0,
    newAvailablePlants: trailEntry.newAvailablePlants ?? trailEntry.after?.availablePlants ?? slot?.availablePlants ?? 0,
    
    // Buffer fields
    bufferPercentage: trailEntry.bufferPercentage ?? slot?.effectiveBuffer ?? slot?.buffer ?? 0,
    bufferAmount: trailEntry.bufferAmount ?? slot?.bufferAmount ?? 0,
    
    // Additional fields
    sowingId: trailEntry.sowingId || null,
    sowingLocation: trailEntry.sowingLocation || null,
    batchNumber: trailEntry.batchNumber || null,
    sowingDate: trailEntry.sowingDate || null,
    plantReadyDate: trailEntry.plantReadyDate || null,
    isExcessiveSowing: trailEntry.isExcessiveSowing ?? false,
    orderId: trailEntry.orderId || null,
    sowingRequestId: trailEntry.sowingRequestId || null,
    requestNumber: trailEntry.requestNumber || null,
    gapCoverageDetails: trailEntry.gapCoverageDetails || null,
    performedBy: trailEntry.performedBy || null,
    metadata: trailEntry.metadata || {},
  };
};

/**
 * Middleware to track slot activity
 * This should be called before any slot update operation
 */
export const trackSlotActivity = async (slotId, activityData, performedBy = null) => {
  try {
    if (!slotId) {
      console.error('Slot ID is required for activity tracking');
      return { success: false, error: 'Slot ID is required' };
    }

    const slotObjectId = new mongoose.Types.ObjectId(slotId);

    // Find the slot
    const plantSlot = await PlantSlot.findOne({ "subtypeSlots.slots._id": slotObjectId });
    
    if (!plantSlot) {
      console.error('Slot not found for activity tracking:', slotId);
      return { success: false, error: 'Slot not found' };
    }

    // Find the specific slot
    let targetSlot = null;
    for (const subtype of plantSlot.subtypeSlots) {
      const slot = subtype.slots.find(s => s._id.toString() === slotId.toString());
      if (slot) {
        targetSlot = slot;
        break;
      }
    }

    if (!targetSlot) {
      console.error('Target slot not found in document');
      return { success: false, error: 'Target slot not found' };
    }

    // Ensure activity data is complete
    const completeActivityData = {
      ...activityData,
      performedBy: performedBy || activityData.performedBy || null,
    };

    const completeTrailEntry = ensureTrailEntryComplete(completeActivityData, targetSlot);

    // Use the slot's logSowingActivity method if it's a sowing activity, otherwise add directly
    if (targetSlot.logSowingActivity && (
      completeTrailEntry.action.includes('SOWING') ||
      completeTrailEntry.action.includes('STOCK_REQUEST') ||
      completeTrailEntry.action.includes('PACKETS')
    )) {
      targetSlot.logSowingActivity(completeTrailEntry);
    } else {
      // Initialize slotTrail if it doesn't exist
      if (!targetSlot.slotTrail) {
        targetSlot.slotTrail = [];
      }
      
      // Add to trail array (newest first)
      targetSlot.slotTrail.unshift(completeTrailEntry);
      
      // Keep only last 1000 entries to prevent unbounded growth
      if (targetSlot.slotTrail.length > 1000) {
        targetSlot.slotTrail = targetSlot.slotTrail.slice(0, 1000);
      }
    }

    // Save the document
    await plantSlot.save();

    return { success: true, trailEntry: completeTrailEntry };
  } catch (error) {
    console.error('Error tracking slot activity:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Middleware function to be used in Express routes
 * Automatically tracks slot activities with user context
 */
export const slotActivityMiddleware = (req, res, next) => {
  // Store original methods
  const originalJson = res.json;
  const originalSend = res.send;

  // Override res.json to track activities after response
  res.json = function (data) {
    // If this is a slot update operation, track it
    if (req.slotActivityData && req.slotId) {
      trackSlotActivity(
        req.slotId,
        req.slotActivityData,
        req.user?._id || null
      ).catch(err => {
        console.error('Error in slot activity middleware:', err);
      });
    }

    return originalJson.call(this, data);
  };

  res.send = function (data) {
    // If this is a slot update operation, track it
    if (req.slotActivityData && req.slotId) {
      trackSlotActivity(
        req.slotId,
        req.slotActivityData,
        req.user?._id || null
      ).catch(err => {
        console.error('Error in slot activity middleware:', err);
      });
    }

    return originalSend.call(this, data);
  };

  next();
};

/**
 * Helper function to set slot activity data in request
 * Use this in controllers before calling next() or sending response
 */
export const setSlotActivity = (req, slotId, activityData) => {
  req.slotId = slotId;
  req.slotActivityData = activityData;
};

export default {
  trackSlotActivity,
  slotActivityMiddleware,
  setSlotActivity,
  ensureTrailEntryComplete,
  getActivityName,
};






