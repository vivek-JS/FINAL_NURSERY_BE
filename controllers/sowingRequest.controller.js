import SowingRequest from '../models/sowingRequest.model.js';
import Product from '../models/product.model.js';
import PlantCms from '../models/plantCms.model.js';
import InventoryOutward from '../models/inventoryOutward.model.js';
import Batch from '../models/batch.model.js';
import InventoryTransaction from '../models/inventoryTransaction.model.js';
import PlantSlot from '../models/slots.model.js';
import mongoose from 'mongoose';

// Create Sowing Request from today's sowing cards
export const createSowingRequest = async (req, res) => {
  try {
    const { plantId, subtypeId, packetsNeeded, packetsRequested, notes } = req.body;

    if (!plantId || !subtypeId || !packetsNeeded) {
      return res.status(400).json({
        success: false,
        message: 'plantId, subtypeId, and packetsNeeded are required',
      });
    }

    // packetsRequested defaults to packetsNeeded if not provided
    const requested = packetsRequested || packetsNeeded;
    const excess = Math.max(0, requested - packetsNeeded);

    // Get plant and subtype info
    const plant = await PlantCms.findById(plantId).select('name subtypes').lean();
    if (!plant) {
      return res.status(404).json({
        success: false,
        message: 'Plant not found',
      });
    }

    const subtype = plant.subtypes?.find(
      (st) => st._id.toString() === subtypeId.toString()
    );
    if (!subtype) {
      return res.status(404).json({
        success: false,
        message: 'Subtype not found',
      });
    }

    // Find product linked to this plant and subtype
    const product = await Product.findOne({
      plantId: new mongoose.Types.ObjectId(plantId),
      subtypeId: new mongoose.Types.ObjectId(subtypeId),
      category: 'seeds',
      isActive: true,
    })
      .select('_id conversionFactor primaryUnit secondaryUnit')
      .populate('primaryUnit', 'name symbol')
      .populate('secondaryUnit', 'name symbol')
      .lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found for this plant and subtype',
      });
    }

    // Check if there's already a pending request for this plant/subtype
    const existingRequest = await SowingRequest.findOne({
      plantId: new mongoose.Types.ObjectId(plantId),
      subtypeId: new mongoose.Types.ObjectId(subtypeId),
      status: 'pending',
    });

    if (existingRequest) {
      return res.status(400).json({
        success: false,
        message: 'A pending request already exists for this plant and subtype',
        data: existingRequest,
      });
    }

    // Generate request number
    const requestNumber = await SowingRequest.generateRequestNumber();

    // Create request
    const request = new SowingRequest({
      requestNumber,
      plantId: new mongoose.Types.ObjectId(plantId),
      plantName: plant.name,
      subtypeId: new mongoose.Types.ObjectId(subtypeId),
      subtypeName: subtype.name,
      productId: product._id,
      packetsNeeded,
      packetsRequested: requested,
      excessPackets: excess,
      primaryUnit: product.primaryUnit?._id,
      secondaryUnit: product.secondaryUnit?._id,
      conversionFactor: product.conversionFactor || 1,
      unitName: product.primaryUnit?.symbol || product.primaryUnit?.name || product.secondaryUnit?.symbol || product.secondaryUnit?.name || 'packets',
      status: 'pending',
      requestedBy: req.user._id,
      notes,
    });

    await request.save();
    await request.populate(['primaryUnit', 'secondaryUnit', 'productId', 'requestedBy']);

    res.status(201).json({
      success: true,
      message: 'Sowing request created successfully',
      data: request,
    });
  } catch (error) {
    console.error('Error creating sowing request:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating sowing request',
      error: error.message,
    });
  }
};

// Get all sowing requests (with optional status filter)
export const getAllSowingRequests = async (req, res) => {
  try {
    const { status } = req.query;
    const query = {};
    if (status && status !== 'all') {
      query.status = status;
    }

    const requests = await SowingRequest.find(query)
      .populate('primaryUnit', 'name symbol')
      .populate('secondaryUnit', 'name symbol')
      .populate('productId', 'name code')
      .populate('requestedBy', 'name')
      .populate('issuedBy', 'name')
      .sort({ requestedDate: -1 })
      .lean();

    // Get available stock for each request
    const requestsWithStock = await Promise.all(
      requests.map(async (request) => {
        let availablePackets = 0;
        try {
          const batches = await Batch.find({
            product: request.productId._id,
            status: 'active',
            remainingQuantity: { $gt: 0 },
          })
            .select('remainingQuantity unit')
            .populate('unit', 'name symbol _id')
            .lean();

          const primaryUnitId = request.primaryUnit?._id?.toString();
          const secondaryUnitId = request.secondaryUnit?._id?.toString();

          let totalAvailable = 0;
          batches.forEach((batch) => {
            const batchUnitId = batch.unit?._id?.toString();
            if (batchUnitId === primaryUnitId) {
              totalAvailable += batch.remainingQuantity;
            } else if (batchUnitId === secondaryUnitId && request.conversionFactor) {
              totalAvailable += batch.remainingQuantity / request.conversionFactor;
            } else {
              totalAvailable += batch.remainingQuantity;
            }
          });

          availablePackets = Math.floor(totalAvailable);
        } catch (error) {
          console.error(`Error fetching stock for request ${request._id}:`, error);
        }

        return {
          ...request,
          availablePackets,
        };
      })
    );

    res.json({
      success: true,
      data: requestsWithStock,
      count: requestsWithStock.length,
    });
  } catch (error) {
    console.error('Error fetching sowing requests:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching sowing requests',
      error: error.message,
    });
  }
};

// Get all pending sowing requests
export const getPendingSowingRequests = async (req, res) => {
  try {
    const requests = await SowingRequest.find({ status: 'pending' })
      .populate('primaryUnit', 'name symbol')
      .populate('secondaryUnit', 'name symbol')
      .populate('productId', 'name code')
      .populate('requestedBy', 'name')
      .sort({ requestedDate: -1 })
      .lean();

    // Get available stock for each request
    const requestsWithStock = await Promise.all(
      requests.map(async (request) => {
        let availablePackets = 0;
        try {
          const batches = await Batch.find({
            product: request.productId._id,
            status: 'active',
            remainingQuantity: { $gt: 0 },
          })
            .select('remainingQuantity unit')
            .populate('unit', 'name symbol _id')
            .lean();

          const primaryUnitId = request.primaryUnit?._id?.toString();
          const secondaryUnitId = request.secondaryUnit?._id?.toString();

          let totalAvailable = 0;
          batches.forEach((batch) => {
            const batchUnitId = batch.unit?._id?.toString();
            if (batchUnitId === primaryUnitId) {
              totalAvailable += batch.remainingQuantity;
            } else if (batchUnitId === secondaryUnitId && request.conversionFactor) {
              totalAvailable += batch.remainingQuantity / request.conversionFactor;
            } else {
              totalAvailable += batch.remainingQuantity;
            }
          });

          availablePackets = Math.floor(totalAvailable);
        } catch (error) {
          console.error(`Error fetching stock for request ${request._id}:`, error);
        }

        return {
          ...request,
          availablePackets,
        };
      })
    );

    res.json({
      success: true,
      data: requestsWithStock,
      count: requestsWithStock.length,
    });
  } catch (error) {
    console.error('Error fetching pending sowing requests:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching pending sowing requests',
      error: error.message,
    });
  }
};

// Get sowing request by ID
export const getSowingRequestById = async (req, res) => {
  try {
    const { id } = req.params;

    const request = await SowingRequest.findById(id)
      .populate('primaryUnit', 'name symbol')
      .populate('secondaryUnit', 'name symbol')
      .populate('productId', 'name code')
      .populate('requestedBy', 'name')
      .populate('issuedBy', 'name')
      .populate('outwardId')
      .lean();

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Sowing request not found',
      });
    }

    // Get available batches for this product
    const batches = await Batch.find({
      product: request.productId._id,
      status: 'active',
      remainingQuantity: { $gt: 0 },
    })
      .populate('unit', 'name symbol')
      .populate('supplier', 'name')
      .sort({ receivedDate: 1 })
      .lean();

    // Calculate available packets
    let availablePackets = 0;
    const primaryUnitId = request.primaryUnit?._id?.toString();
    const secondaryUnitId = request.secondaryUnit?._id?.toString();

    batches.forEach((batch) => {
      const batchUnitId = batch.unit?._id?.toString();
      if (batchUnitId === primaryUnitId) {
        availablePackets += batch.remainingQuantity;
      } else if (batchUnitId === secondaryUnitId && request.conversionFactor) {
        availablePackets += batch.remainingQuantity / request.conversionFactor;
      } else {
        availablePackets += batch.remainingQuantity;
      }
    });

    res.json({
      success: true,
      data: {
        ...request,
        availablePackets: Math.floor(availablePackets),
        batches,
      },
    });
  } catch (error) {
    console.error('Error fetching sowing request:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching sowing request',
      error: error.message,
    });
  }
};

// Update sowing request
export const updateSowingRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { packetsRequested, notes } = req.body;

    const request = await SowingRequest.findById(id);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Sowing request not found',
      });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Cannot update request with status: ${request.status}`,
      });
    }

    // Update packetsRequested if provided
    if (packetsRequested !== undefined) {
      if (packetsRequested < request.packetsNeeded) {
        return res.status(400).json({
          success: false,
          message: `Requested packets (${packetsRequested}) cannot be less than needed (${request.packetsNeeded})`,
        });
      }
      request.packetsRequested = packetsRequested;
      request.excessPackets = Math.max(0, packetsRequested - request.packetsNeeded);
    }

    if (notes !== undefined) {
      request.notes = notes;
    }

    await request.save();
    await request.populate(['primaryUnit', 'secondaryUnit', 'productId', 'requestedBy']);

    res.json({
      success: true,
      message: 'Sowing request updated successfully',
      data: request,
    });
  } catch (error) {
    console.error('Error updating sowing request:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating sowing request',
      error: error.message,
    });
  }
};

// Issue stock from sowing request (exact quantity validation)
export const issueStockFromRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { batchAllocations, notes } = req.body;

    const request = await SowingRequest.findById(id);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Sowing request not found',
      });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Request is already ${request.status}`,
      });
    }

    // Validate batch allocations
    if (!batchAllocations || !Array.isArray(batchAllocations) || batchAllocations.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Batch allocations are required',
      });
    }

    // Calculate total quantity from allocations
    let totalAllocated = 0;
    const primaryUnitId = request.primaryUnit?._id?.toString();
    const secondaryUnitId = request.secondaryUnit?._id?.toString();

    for (const allocation of batchAllocations) {
      const batch = await Batch.findById(allocation.batchId)
        .populate('unit', 'name symbol _id')
        .lean();

      if (!batch) {
        return res.status(404).json({
          success: false,
          message: `Batch ${allocation.batchId} not found`,
        });
      }

      if (batch.status !== 'active') {
        return res.status(400).json({
          success: false,
          message: `Batch ${batch.batchNumber} is not active`,
        });
      }

      const batchUnitId = batch.unit?._id?.toString();
      let quantityInPackets = 0;

      if (batchUnitId === primaryUnitId) {
        quantityInPackets = allocation.quantity;
      } else if (batchUnitId === secondaryUnitId && request.conversionFactor) {
        quantityInPackets = allocation.quantity / request.conversionFactor;
      } else {
        quantityInPackets = allocation.quantity;
      }

      totalAllocated += quantityInPackets;

      // Validate batch has enough quantity
      if (batch.remainingQuantity < allocation.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient quantity in batch ${batch.batchNumber}. Available: ${batch.remainingQuantity}, Required: ${allocation.quantity}`,
        });
      }
    }

    // Validate quantity match (must equal packetsRequested, not packetsNeeded)
    const packetsRequested = request.packetsRequested || request.packetsNeeded;
    if (Math.abs(totalAllocated - packetsRequested) > 0.01) {
      return res.status(400).json({
        success: false,
        message: `Total allocated quantity (${totalAllocated.toFixed(2)}) must exactly match requested quantity (${packetsRequested}). Not more, not less.`,
      });
    }

    // Calculate excess packets
    const excessPackets = Math.max(0, totalAllocated - request.packetsNeeded);

    // Create outward entry and issue stock directly
    const outwardNumber = await InventoryOutward.generateOutwardNumber();
    const outwardItems = batchAllocations.map((allocation) => ({
      product: request.productId,
      batch: allocation.batchId,
      quantity: allocation.quantity,
      unit: request.primaryUnit || request.secondaryUnit,
      notes: allocation.notes || notes,
    }));

    const outward = new InventoryOutward({
      outwardNumber,
      outwardDate: new Date(),
      purpose: 'production',
      purposeDetails: `Sowing request: ${request.requestNumber} - ${request.plantName} ${request.subtypeName}${excessPackets > 0 ? ` (Excess: ${excessPackets.toFixed(2)} packets)` : ''}`,
      department: 'Sowing',
      destination: 'Sowing Department',
      items: outwardItems,
      totalAmount: 0,
      status: 'draft',
      createdBy: req.user._id,
      linkedSlotIds: request.linkedSlotIds || [], // Link to slots
      sowingRequestId: request._id, // Link to sowing request
      notes: notes || `Issued from sowing request ${request.requestNumber}${excessPackets > 0 ? ` (Excess: ${excessPackets.toFixed(2)} packets)` : ''}`,
    });

    await outward.save();

    // Issue stock directly (deduct from batches and products)
    const product = await Product.findById(request.productId);
    if (!product) {
      throw new Error('Product not found');
    }

    // Helper to create inventory transaction
    const createOutwardTransaction = async (item, outward, user) => {
      const transactionNumber = await InventoryTransaction.generateTransactionNumber();
      const transaction = new InventoryTransaction({
        transactionNumber,
        transactionType: 'outward',
        product: item.product,
        batch: item.batch,
        quantity: item.quantity,
        unit: item.unit,
        balanceBeforeTransaction: product.currentStock,
        balanceAfterTransaction: product.currentStock - item.quantity,
        rate: 0,
        value: 0,
        referenceType: 'Outward',
        referenceId: outward._id,
        referenceNumber: outward.outwardNumber,
        fromLocation: 'Main Warehouse',
        toLocation: outward.destination || outward.department,
        reason: outward.purpose,
        remarks: outward.purposeDetails,
        performedBy: user._id,
      });
      await transaction.save();
      return transaction;
    };

    // Update batches and product stock
    for (const item of outward.items) {
      const batch = await Batch.findById(item.batch);
      if (!batch) {
        throw new Error(`Batch not found for item`);
      }

      if (batch.remainingQuantity < item.quantity) {
        throw new Error(`Insufficient stock in batch ${batch.batchNumber}`);
      }

      if (batch.status !== 'active') {
        throw new Error(`Batch ${batch.batchNumber} is not active`);
      }

      // Update batch
      batch.remainingQuantity -= item.quantity;
      if (batch.remainingQuantity <= 0) {
        batch.status = 'exhausted';
      }
      await batch.save();

      // Validate and update product stock
      if (product.currentStock < item.quantity) {
        throw new Error(`Insufficient stock. Available: ${product.currentStock}, Required: ${item.quantity}`);
      }

      product.currentStock -= item.quantity;
      if (product.currentStock > 0 && product.stockValue > 0) {
        product.averagePrice = product.stockValue / product.currentStock;
      } else {
        product.averagePrice = 0;
      }
      product.updatedBy = req.user._id;
      await product.save();

      // Create inventory transaction
      await createOutwardTransaction(item, outward, req.user);
    }

    // Update outward status to issued
    outward.status = 'issued';
    outward.issuedBy = req.user._id;
    outward.issuedDate = new Date();
    outward.updatedBy = req.user._id;
    await outward.save();

    // Update request status and excess packets
    request.status = 'issued';
    request.issuedBy = req.user._id;
    request.issuedDate = new Date();
    request.outwardId = outward._id;
    request.excessPackets = excessPackets;
    await request.save();

    // Update slots' sowingInProgress array
    if (request.linkedSlotIds && request.linkedSlotIds.length > 0) {
      const sowingProgressEntry = {
        requestNumber: request.requestNumber,
        packetsIssued: packetsRequested,
        plantsExpected: request.remainingSowingNeeded || request.packetsNeeded * (request.conversionFactor || 1),
        outwardId: outward._id,
        sowingRequestId: request._id,
        isExcessiveSowing: request.isExcessiveSowing || false,
        issuedDate: new Date(),
      };

      // Update each linked slot
      for (const slotId of request.linkedSlotIds) {
        try {
          // Find the plant slot document containing this slot
          const plantSlot = await PlantSlot.findOne({
            'subtypeSlots.slots._id': slotId,
          });

          if (plantSlot) {
            // Find the specific slot within the nested structure
            for (const subtypeSlot of plantSlot.subtypeSlots) {
              const slot = subtypeSlot.slots.find(s => s._id.toString() === slotId.toString());
              if (slot) {
                // Initialize sowingInProgress as array if it's a boolean (backward compatibility)
                if (typeof slot.sowingInProgress === 'boolean') {
                  slot.sowingInProgress = [];
                }
                
                // Add the new progress entry
                if (!Array.isArray(slot.sowingInProgress)) {
                  slot.sowingInProgress = [];
                }
                slot.sowingInProgress.push(sowingProgressEntry);
                
                // Add trail entry
                slot.slotTrail = slot.slotTrail || [];
                slot.slotTrail.push({
                  action: 'STOCK_REQUEST_ISSUED',
                  quantity: sowingProgressEntry.packetsIssued,
                  previousTotalPlants: slot.totalPlants || 0,
                  newTotalPlants: slot.totalPlants || 0,
                  previousAvailablePlants: slot.availablePlants || 0,
                  newAvailablePlants: slot.availablePlants || 0,
                  reason: `Stock issued for ${request.requestNumber}: ${sowingProgressEntry.packetsIssued} packets (${sowingProgressEntry.plantsExpected} plants expected)`,
                  sowingRequestId: request._id,
                  performedBy: req.user._id,
                  notes: `Outward: ${outward.outwardNumber}`,
                });

                await plantSlot.save();
                break;
              }
            }
          }
        } catch (slotError) {
          console.error(`Error updating slot ${slotId}:`, slotError);
          // Continue with other slots even if one fails
        }
      }
    }

    await request.populate(['primaryUnit', 'secondaryUnit', 'productId', 'issuedBy', 'outwardId']);

    res.json({
      success: true,
      message: 'Stock issued successfully from sowing request',
      data: {
        request,
        outward,
      },
    });
  } catch (error) {
    console.error('Error issuing stock from request:', error);
    res.status(500).json({
      success: false,
      message: 'Error issuing stock from request',
      error: error.message,
    });
  }
};

// Reject sowing request
export const rejectSowingRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { rejectionReason } = req.body;

    const request = await SowingRequest.findById(id);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Sowing request not found',
      });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Cannot reject request with status: ${request.status}`,
      });
    }

    request.status = 'rejected';
    request.rejectedBy = req.user._id;
    request.rejectedDate = new Date();
    request.rejectionReason = rejectionReason || 'No reason provided';
    await request.save();

    await request.populate(['rejectedBy']);

    res.json({
      success: true,
      message: 'Sowing request rejected successfully',
      data: request,
    });
  } catch (error) {
    console.error('Error rejecting sowing request:', error);
    res.status(500).json({
      success: false,
      message: 'Error rejecting sowing request',
      error: error.message,
    });
  }
};

// Cancel sowing request
export const cancelSowingRequest = async (req, res) => {
  try {
    const { id } = req.params;

    const request = await SowingRequest.findById(id);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Sowing request not found',
      });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel request with status: ${request.status}`,
      });
    }

    request.status = 'cancelled';
    request.cancelledBy = req.user?._id;
    request.cancelledDate = new Date();
    await request.save();

    res.json({
      success: true,
      message: 'Sowing request cancelled successfully',
      data: request,
    });
  } catch (error) {
    console.error('Error cancelling sowing request:', error);
    res.status(500).json({
      success: false,
      message: 'Error cancelling sowing request',
      error: error.message,
    });
  }
};

// Cancel all pending sowing requests (for testing)
export const cancelAllSowingRequests = async (req, res) => {
  try {
    const result = await SowingRequest.updateMany(
      { status: 'pending' },
      {
        $set: {
          status: 'cancelled',
          cancelledBy: req.user?._id,
          cancelledDate: new Date(),
        },
      }
    );

    res.json({
      success: true,
      message: `Cancelled ${result.modifiedCount} pending sowing request(s)`,
      data: {
        cancelledCount: result.modifiedCount,
      },
    });
  } catch (error) {
    console.error('Error cancelling all sowing requests:', error);
    res.status(500).json({
      success: false,
      message: 'Error cancelling all sowing requests',
      error: error.message,
    });
  }
};

// Check if request exists for plant/subtype
export const checkRequestExists = async (req, res) => {
  try {
    const { plantId, subtypeId } = req.query;

    if (!plantId || !subtypeId) {
      return res.status(400).json({
        success: false,
        message: 'plantId and subtypeId are required',
      });
    }

    const request = await SowingRequest.findOne({
      plantId: new mongoose.Types.ObjectId(plantId),
      subtypeId: new mongoose.Types.ObjectId(subtypeId),
      status: { $in: ['pending', 'processing', 'issued'] },
    })
      .populate('requestedBy', 'name')
      .populate('issuedBy', 'name')
      .sort({ requestedDate: -1 })
      .lean();

    if (request) {
      // Check if issued today
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const issuedDate = request.issuedDate ? new Date(request.issuedDate) : null;
      const isIssuedToday = issuedDate && issuedDate >= today;

      return res.json({
        success: true,
        exists: true,
        data: {
          ...request,
          isIssuedToday,
        },
      });
    }

    res.json({
      success: true,
      exists: false,
      data: null,
    });
  } catch (error) {
    console.error('Error checking request existence:', error);
    res.status(500).json({
      success: false,
      message: 'Error checking request existence',
      error: error.message,
    });
  }
};
