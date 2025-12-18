import SowingRequest from '../models/sowingRequest.model.js';
import PlantSlot from '../models/slots.model.js';
import Sowing from '../models/sowing.model.js';
import InventoryOutward from '../models/inventoryOutward.model.js';
import Batch from '../models/batch.model.js';
import InventoryTransaction from '../models/inventoryTransaction.model.js';
import Product from '../models/product.model.js';
import mongoose from 'mongoose';
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
    const wasJustCompleted = request.remainingSowingNeeded <= 0 && !request.sowingCompleted;
    if (request.remainingSowingNeeded <= 0) {
      request.sowingCompleted = true;
      request.sowingCompletedDate = new Date();
      request.sowingInProgress = false;
    } else if (!request.sowingInProgress) {
      request.sowingInProgress = true;
      request.sowingStartedDate = new Date();
    }

    await request.save();

    // Remove from all linked slots' sowingInProgress array when completed
    if (wasJustCompleted && request.linkedSlotIds && request.linkedSlotIds.length > 0) {
      for (const linkedSlotId of request.linkedSlotIds) {
        try {
          const plantSlotDoc = await PlantSlot.findOne({
            'subtypeSlots.slots._id': linkedSlotId,
          });

          if (plantSlotDoc) {
            for (const subtypeSlot of plantSlotDoc.subtypeSlots) {
              const slot = subtypeSlot.slots.find(s => s._id.toString() === linkedSlotId.toString());
              if (slot) {
                // Remove this request from sowingInProgress array
                if (Array.isArray(slot.sowingInProgress)) {
                  slot.sowingInProgress = slot.sowingInProgress.filter(
                    prog => prog.sowingRequestId?.toString() !== request._id.toString()
                  );
                }

                // Add completion trail entry
                if (!slot.slotTrail) {
                  slot.slotTrail = [];
                }
                slot.slotTrail.unshift({
                  action: 'SOWING_COMPLETED',
                  quantity: sowedQuantity,
                  previousTotalPlants: slot.totalPlants || 0,
                  newTotalPlants: slot.totalPlants || 0,
                  previousAvailablePlants: slot.availablePlants || 0,
                  newAvailablePlants: slot.availablePlants || 0,
                  reason: `Sowing completed for ${request.requestNumber}`,
                  sowingRequestId: request._id,
                  performedBy: req.user._id,
                  notes: `Request ${request.requestNumber} completed: ${request.sowedQuantity} plants sowed`,
                });

                await plantSlotDoc.save();
                console.log(`✅ Removed request ${request.requestNumber} from slot ${linkedSlotId} sowingInProgress`);
                break;
              }
            }
          }
        } catch (slotError) {
          console.error(`Error updating slot ${linkedSlotId}:`, slotError);
          // Continue with other slots
        }
      }
    }

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

    const wasJustCompleted = remaining <= 0 && !request.sowingCompleted;
    if (remaining <= 0 && !request.sowingCompleted) {
      request.sowingCompleted = true;
      request.sowingCompletedDate = new Date();
      request.sowingInProgress = false;
    }

    await request.save();

    // Remove from all linked slots' sowingInProgress array when completed
    if (wasJustCompleted && request.linkedSlotIds && request.linkedSlotIds.length > 0) {
      for (const linkedSlotId of request.linkedSlotIds) {
        try {
          const plantSlotDoc = await PlantSlot.findOne({
            'subtypeSlots.slots._id': linkedSlotId,
          });

          if (plantSlotDoc) {
            for (const subtypeSlot of plantSlotDoc.subtypeSlots) {
              const slot = subtypeSlot.slots.find(s => s._id.toString() === linkedSlotId.toString());
              if (slot) {
                // Remove this request from sowingInProgress array
                if (Array.isArray(slot.sowingInProgress)) {
                  slot.sowingInProgress = slot.sowingInProgress.filter(
                    prog => prog.sowingRequestId?.toString() !== request._id.toString()
                  );
                }

                // Add completion trail entry
                if (!slot.slotTrail) {
                  slot.slotTrail = [];
                }
                slot.slotTrail.unshift({
                  action: 'SOWING_COMPLETED',
                  quantity: totalSowed,
                  previousTotalPlants: slot.totalPlants || 0,
                  newTotalPlants: slot.totalPlants || 0,
                  previousAvailablePlants: slot.availablePlants || 0,
                  newAvailablePlants: slot.availablePlants || 0,
                  reason: `Sowing completed for ${request.requestNumber} (recalculated)`,
                  sowingRequestId: request._id,
                  performedBy: req.user._id,
                  notes: `Request ${request.requestNumber} completed via recalculation: ${totalSowed} plants total`,
                });

                await plantSlotDoc.save();
                console.log(`✅ Removed request ${request.requestNumber} from slot ${linkedSlotId} sowingInProgress (recalc)`);
                break;
              }
            }
          }
        } catch (slotError) {
          console.error(`Error updating slot ${linkedSlotId}:`, slotError);
          // Continue with other slots
        }
      }
    }

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

/**
 * Cancel sowing request and revert all changes
 * - Remove from slot's sowingInProgress array
 * - Return stock to inventory (update batch usedQuantity)
 * - Create return transaction
 * - Mark request as cancelled
 * POST /api/v1/sowing/request/:requestId/cancel
 */
export const cancelSowingRequest = async (req, res) => {
  try {
    const { requestId } = req.params;
    const { reason } = req.body;

    // Find the sowing request
    const request = await SowingRequest.findById(requestId)
      .populate('plantId', 'name')
      .populate('subtypeId', 'name')
      .populate('productId', 'name conversionFactor primaryUnit secondaryUnit');

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Sowing request not found',
      });
    }

    // Check if request can be cancelled
    if (request.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Request is already cancelled',
      });
    }

    if (request.sowingCompleted) {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel a completed sowing request',
      });
    }

    if (!request.outwardId) {
      // No stock was issued yet, just mark as cancelled
      request.status = 'cancelled';
      request.cancelledBy = req.user._id;
      request.cancelledDate = new Date();
      request.cancellationReason = reason || 'Request cancelled before stock issuance';
      await request.save();

      return res.status(200).json({
        success: true,
        message: 'Request cancelled successfully (no stock was issued)',
        request,
      });
    }

    // Stock was issued - need to revert everything
    console.log(`🔄 Cancelling sowing request ${request.requestNumber}...`);

    // Step 1: Find the outward record
    const outward = await InventoryOutward.findById(request.outwardId);
    if (!outward) {
      return res.status(404).json({
        success: false,
        message: 'Outward record not found',
      });
    }

    console.log(`📦 Found outward: ${outward.outwardNumber}`);

    // Step 2: Revert inventory - update batch remainingQuantity and product currentStock
    const revertedBatches = [];
    
    if (outward.items && Array.isArray(outward.items)) {
      for (const item of outward.items) {
        const batch = await Batch.findById(item.batch);
        if (batch) {
          const previousRemaining = batch.remainingQuantity || 0;
          batch.remainingQuantity = previousRemaining + item.quantity;
          await batch.save();
          
          // Update product currentStock
          const product = await Product.findById(item.product);
          if (product) {
            const previousStock = product.currentStock || 0;
            product.currentStock = previousStock + item.quantity;
            await product.save();
            console.log(`✅ Updated product ${product.name}: ${previousStock} → ${product.currentStock} (returned ${item.quantity})`);
          }
          
          revertedBatches.push({
            batchId: batch._id,
            batchNumber: batch.batchNumber,
            quantityReturned: item.quantity,
            previousRemaining,
            newRemaining: batch.remainingQuantity,
          });

          console.log(`✅ Reverted batch ${batch.batchNumber}: ${previousRemaining} → ${batch.remainingQuantity} (returned ${item.quantity})`);

          // Create return transaction with updated balance
          const transactionNumber = await InventoryTransaction.generateTransactionNumber();
          const updatedProduct = await Product.findById(item.product);
          const transaction = new InventoryTransaction({
            transactionNumber,
            transactionDate: new Date(),
            transactionType: 'return',
            product: item.product,
            batch: batch._id,
            quantity: item.quantity,
            unit: item.unit,
            balanceBeforeTransaction: (updatedProduct?.currentStock || 0) - item.quantity,
            balanceAfterTransaction: updatedProduct?.currentStock || 0,
            referenceType: 'Outward',
            referenceId: outward._id,
            referenceNumber: outward.outwardNumber,
            reason: `Cancelled sowing request: ${request.requestNumber}`,
            remarks: reason || 'Stock returned due to sowing cancellation',
            performedBy: req.user._id,
            metadata: {
              sowingRequestId: request._id,
              sowingRequestNumber: request.requestNumber,
              cancelledBy: req.user._id,
              cancelledDate: new Date(),
            },
          });
          await transaction.save();
          console.log(`📝 Created return transaction: ${transactionNumber}`);
        }
      }
    }

    // Step 3: Revert slot changes - remove from sowingInProgress array
    const revertedSlots = [];
    if (request.linkedSlotIds && request.linkedSlotIds.length > 0) {
      for (const slotId of request.linkedSlotIds) {
        const plantSlotDoc = await PlantSlot.findOne({
          'subtypeSlots.slots._id': slotId,
        });

        if (plantSlotDoc) {
          for (const subtypeSlot of plantSlotDoc.subtypeSlots) {
            const slot = subtypeSlot.slots.find(s => s._id.toString() === slotId.toString());
            if (slot) {
              // Find and remove the entry from sowingInProgress
              const progressEntry = Array.isArray(slot.sowingInProgress)
                ? slot.sowingInProgress.find(prog => prog.sowingRequestId?.toString() === request._id.toString())
                : null;

              if (progressEntry) {
                slot.sowingInProgress = slot.sowingInProgress.filter(
                  prog => prog.sowingRequestId?.toString() !== request._id.toString()
                );

                // Add cancellation trail entry
                if (!slot.slotTrail) {
                  slot.slotTrail = [];
                }
                slot.slotTrail.unshift({
                  action: 'SOWING_CANCELLED',
                  quantity: progressEntry.packetsIssued,
                  previousTotalPlants: slot.totalPlants || 0,
                  newTotalPlants: slot.totalPlants || 0,
                  previousAvailablePlants: slot.availablePlants || 0,
                  newAvailablePlants: slot.availablePlants || 0,
                  reason: reason || `Sowing cancelled for ${request.requestNumber}`,
                  sowingRequestId: request._id,
                  performedBy: req.user._id,
                  notes: `Cancelled: ${progressEntry.packetsIssued} packets (${progressEntry.plantsExpected} plants) returned to inventory`,
                });

                await plantSlotDoc.save();
                
                revertedSlots.push({
                  slotId: slot._id,
                  slotIdentifier: `${slot.slotStartDay} - ${slot.slotEndDay}`,
                  packetsReturned: progressEntry.packetsIssued,
                  plantsReturned: progressEntry.plantsExpected,
                });

                console.log(`✅ Removed request from slot ${slotId} sowingInProgress`);
              }
            }
          }
        }
      }
    }

    // Step 4: Mark outward as cancelled
    outward.status = 'cancelled';
    outward.cancelledBy = req.user._id;
    outward.cancelledDate = new Date();
    outward.notes = `${outward.notes || ''}\n[CANCELLED] ${reason || 'Sowing request cancelled'}`.trim();
    await outward.save();

    // Step 5: Mark request as cancelled
    request.status = 'cancelled';
    request.sowingInProgress = false;
    request.cancelledBy = req.user._id;
    request.cancelledDate = new Date();
    request.cancellationReason = reason || 'Sowing request cancelled';
    await request.save();

    console.log(`✅ Successfully cancelled sowing request ${request.requestNumber}`);

    return res.status(200).json({
      success: true,
      message: 'Sowing request cancelled successfully. All changes reverted.',
      request: {
        _id: request._id,
        requestNumber: request.requestNumber,
        status: request.status,
        plantName: request.plantId?.name,
        subtypeName: request.subtypeId?.name,
        packetsRequested: request.packetsRequested,
        cancelledBy: req.user._id,
        cancelledDate: request.cancelledDate,
        cancellationReason: request.cancellationReason,
      },
      reverted: {
        outward: {
          outwardNumber: outward.outwardNumber,
          status: outward.status,
        },
        batches: revertedBatches,
        slots: revertedSlots,
        totalPacketsReturned: revertedBatches.reduce((sum, b) => sum + b.quantityReturned, 0),
        totalSlotsUpdated: revertedSlots.length,
      },
    });
  } catch (error) {
    console.error('❌ Error cancelling sowing request:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to cancel sowing request',
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
  cancelSowingRequest,
};
