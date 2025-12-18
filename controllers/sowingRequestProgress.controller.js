import SowingRequest from '../models/sowingRequest.model.js';
import PlantSlot from '../models/slots.model.js';
import Sowing from '../models/sowing.model.js';
import moment from 'moment';
import {
  logSowingRequestIssued,
  logSowingStarted,
  logSowingCompleted,
  calculateRemainingSowing,
} from '../helpers/slotTransactionLogger.js';

/**
 * Update request status to "issued" when stock is issued from inventory
 * PUT /api/v1/sowing/request/:requestId/mark-issued
 */
export const markRequestAsIssued = async (req, res) => {
  try {
    const { requestId } = req.params;
    const { outwardId } = req.body;

    const request = await SowingRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Sowing request not found',
      });
    }

    if (request.status !== 'pending' && request.status !== 'processing') {
      return res.status(400).json({
        success: false,
        message: `Cannot mark as issued. Current status: ${request.status}`,
      });
    }

    // Update request
    request.status = 'issued';
    request.issuedBy = req.user._id;
    request.issuedDate = new Date();
    request.outwardId = outwardId;
    request.sowingInProgress = true;

    await request.save();

    // Update linked slots
    if (request.linkedSlotIds && request.linkedSlotIds.length > 0) {
      for (const slotId of request.linkedSlotIds) {
        const plantSlotDoc = await PlantSlot.findOne({
          'subtypeSlots.slots._id': slotId,
        });

        if (plantSlotDoc) {
          const subtypeSlot = plantSlotDoc.subtypeSlots.find((st) =>
            st.slots.some((s) => s._id.toString() === slotId.toString())
          );

          if (subtypeSlot) {
            const slot = subtypeSlot.slots.id(slotId);
            if (slot) {
              logSowingRequestIssued(
                slot,
                request._id,
                request.packetsRequested,
                req.user._id,
                {
                  outwardId,
                  notes: `Stock issued for request ${request.requestNumber}`,
                }
              );

              await plantSlotDoc.save();
            }
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Request marked as issued successfully',
      data: request,
    });
  } catch (error) {
    console.error('Error marking request as issued:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to mark request as issued',
      error: error.message,
    });
  }
};

/**
 * Update sowing progress when plants are sowed
 * PUT /api/v1/sowing/request/:requestId/update-progress
 */
export const updateSowingProgress = async (req, res) => {
  try {
    const { requestId } = req.params;
    const { sowedQuantity, slotId, sowingId } = req.body;

    const request = await SowingRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Sowing request not found',
      });
    }

    if (request.status !== 'issued') {
      return res.status(400).json({
        success: false,
        message: `Cannot update progress. Request must be issued first. Current status: ${request.status}`,
      });
    }

    // Update request progress
    request.sowedQuantity = (request.sowedQuantity || 0) + sowedQuantity;
    
    const expectedPlants = request.packetsRequested * request.conversionFactor;
    request.remainingSowingNeeded = Math.max(0, expectedPlants - request.sowedQuantity);

    // Check if sowing is completed
    if (request.remainingSowingNeeded <= 0) {
      request.sowingCompleted = true;
      request.sowingCompletedDate = new Date();
      request.sowingInProgress = false;
    } else if (!request.sowingInProgress) {
      request.sowingInProgress = true;
      request.sowingStartedDate = new Date();
    }

    await request.save();

    // Update slot if provided
    if (slotId) {
      const plantSlotDoc = await PlantSlot.findOne({
        'subtypeSlots.slots._id': slotId,
      });

      if (plantSlotDoc) {
        const subtypeSlot = plantSlotDoc.subtypeSlots.find((st) =>
          st.slots.some((s) => s._id.toString() === slotId.toString())
        );

        if (subtypeSlot) {
          const slot = subtypeSlot.slots.id(slotId);
          if (slot) {
            if (!request.sowingStartedDate && request.sowingInProgress) {
              logSowingStarted(slot, sowedQuantity, req.user._id, {
                sowingDate: moment().format('DD-MM-YYYY'),
                location: 'OFFICE', // or PRIMARY based on sowing location
                notes: `Sowing in progress for request ${request.requestNumber}`,
              });
            }

            if (request.sowingCompleted) {
              logSowingCompleted(slot, request.sowedQuantity, req.user._id, {
                notes: `Sowing completed for request ${request.requestNumber}`,
              });
            }

            await plantSlotDoc.save();
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: request.sowingCompleted
        ? 'Sowing completed successfully'
        : 'Sowing progress updated',
      data: {
        request,
        remainingSowing: request.remainingSowingNeeded,
        isCompleted: request.sowingCompleted,
      },
    });
  } catch (error) {
    console.error('Error updating sowing progress:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update sowing progress',
      error: error.message,
    });
  }
};

/**
 * Get sowing request status and progress
 * GET /api/v1/sowing/request/:requestId/status
 */
export const getSowingRequestStatus = async (req, res) => {
  try {
    const { requestId } = req.params;

    const request = await SowingRequest.findById(requestId)
      .populate('requestedBy', 'name')
      .populate('issuedBy', 'name')
      .populate('plantId', 'plantName')
      .populate('productId', 'productName')
      .populate('outwardId')
      .lean();

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Sowing request not found',
      });
    }

    // Get sowings created for this request
    const sowings = await Sowing.find({
      plantId: request.plantId,
      subtypeId: request.subtypeId,
      batchNumber: { $exists: true }, // Should match batch from request
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    // Calculate progress percentage
    const expectedPlants = request.packetsRequested * request.conversionFactor;
    const progressPercentage =
      expectedPlants > 0
        ? Math.min(100, Math.round((request.sowedQuantity / expectedPlants) * 100))
        : 0;

    // Get slot information
    let slotInfo = null;
    if (request.linkedSlotIds && request.linkedSlotIds.length > 0) {
      const plantSlotDoc = await PlantSlot.findOne({
        'subtypeSlots.slots._id': request.linkedSlotIds[0],
      }).lean();

      if (plantSlotDoc) {
        const subtypeSlot = plantSlotDoc.subtypeSlots.find((st) =>
          st.slots.some(
            (s) => s._id.toString() === request.linkedSlotIds[0].toString()
          )
        );

        if (subtypeSlot) {
          const slot = subtypeSlot.slots.find(
            (s) => s._id.toString() === request.linkedSlotIds[0].toString()
          );
          if (slot) {
            slotInfo = {
              slotId: slot._id,
              startDay: slot.startDay,
              endDay: slot.endDay,
              totalPlants: slot.totalPlants,
              primarySowed: slot.primarySowed,
              officeSowed: slot.officeSowed,
              sowingInProgress: slot.sowingInProgress,
              sowingCompleted: slot.sowingCompleted,
              excessiveSowing: slot.excessiveSowing,
            };
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        request,
        progress: {
          expectedPlants,
          sowedQuantity: request.sowedQuantity || 0,
          remainingSowing: request.remainingSowingNeeded || 0,
          progressPercentage,
        },
        sowingInProgress: request.sowingInProgress,
        sowingCompleted: request.sowingCompleted,
        slot: slotInfo,
        recentSowings: sowings,
      },
    });
  } catch (error) {
    console.error('Error getting sowing request status:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get request status',
      error: error.message,
    });
  }
};

/**
 * Get all active sowing requests with progress
 * GET /api/v1/sowing/request/active
 */
export const getActiveSowingRequests = async (req, res) => {
  try {
    const { status } = req.query;

    const query = {};
    if (status) {
      query.status = status;
    } else {
      // Default: show issued and in-progress requests
      query.status = { $in: ['issued', 'processing'] };
    }

    const requests = await SowingRequest.find(query)
      .populate('requestedBy', 'name')
      .populate('issuedBy', 'name')
      .populate('plantId', 'plantName')
      .populate('productId', 'productName')
      .sort({ requestedDate: -1 })
      .lean();

    // Calculate progress for each request
    const requestsWithProgress = requests.map((request) => {
      const expectedPlants = request.packetsRequested * request.conversionFactor;
      const progressPercentage =
        expectedPlants > 0
          ? Math.min(100, Math.round((request.sowedQuantity / expectedPlants) * 100))
          : 0;

      return {
        ...request,
        progress: {
          expectedPlants,
          sowedQuantity: request.sowedQuantity || 0,
          remainingSowing: request.remainingSowingNeeded || 0,
          progressPercentage,
        },
      };
    });

    return res.status(200).json({
      success: true,
      count: requestsWithProgress.length,
      data: requestsWithProgress,
    });
  } catch (error) {
    console.error('Error getting active sowing requests:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get active requests',
      error: error.message,
    });
  }
};

/**
 * Recalculate sowing remaining for a request
 * POST /api/v1/sowing/request/:requestId/recalculate
 */
export const recalculateSowingRemaining = async (req, res) => {
  try {
    const { requestId } = req.params;

    const request = await SowingRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Sowing request not found',
      });
    }

    // Get all sowings for this plant/subtype
    const sowings = await Sowing.find({
      plantId: request.plantId,
      subtypeId: request.subtypeId,
      createdAt: { $gte: request.requestedDate },
    }).lean();

    const totalSowed = sowings.reduce(
      (sum, sowing) => sum + (sowing.sowedPlant || 0),
      0
    );

    const expectedPlants = request.packetsRequested * request.conversionFactor;
    const remaining = Math.max(0, expectedPlants - totalSowed);

    request.sowedQuantity = totalSowed;
    request.remainingSowingNeeded = remaining;

    if (remaining <= 0 && !request.sowingCompleted) {
      request.sowingCompleted = true;
      request.sowingCompletedDate = new Date();
      request.sowingInProgress = false;
    }

    await request.save();

    return res.status(200).json({
      success: true,
      message: 'Sowing remaining recalculated',
      data: {
        expectedPlants,
        totalSowed,
        remaining,
        sowingCompleted: request.sowingCompleted,
      },
    });
  } catch (error) {
    console.error('Error recalculating sowing remaining:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to recalculate sowing remaining',
      error: error.message,
    });
  }
};

export default {
  markRequestAsIssued,
  updateSowingProgress,
  getSowingRequestStatus,
  getActiveSowingRequests,
  recalculateSowingRemaining,
};
