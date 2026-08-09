import SowingRequest from '../models/sowingRequest.model.js';
import Product from '../models/product.model.js';
import PlantCms from '../models/plantCms.model.js';
import InventoryOutward from '../models/inventoryOutward.model.js';
import Batch from '../models/batch.model.js';
import InventoryTransaction from '../models/inventoryTransaction.model.js';
import PlantSlot from '../models/slots.model.js';
import mongoose from 'mongoose';
import { resolveSowingPlantsPerPacket } from '../utility/sowingPlantsPerPacket.js';

const applySowingBuffer = (baseValue, bufferPercent) => {
  const qty = Number(baseValue) || 0;
  const buffer = Number(bufferPercent) || 0;
  return buffer > 0 ? Math.round(qty * (1 + buffer / 100)) : qty;
};

/** Warehouse issue qty = company packets only (raising is allocated at create). */
const resolveCompanyIssuePackets = (request) => {
  if (
    request?.packetsFromCompany != null &&
    Number.isFinite(Number(request.packetsFromCompany))
  ) {
    return Math.max(0, Number(request.packetsFromCompany));
  }
  if (request?.seedSource === "RAISING") return 0;
  return Math.max(0, Number(request?.packetsRequested || request?.packetsNeeded) || 0);
};

const enrichRequestsWithBufferContext = async (requests) => {
  const plantIds = [...new Set((requests || []).map((r) => String(r.plantId)).filter(Boolean))]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const plants = await PlantCms.find({ _id: { $in: plantIds } })
    .select("_id sowingBuffer")
    .lean();
  const plantBufferMap = new Map(plants.map((p) => [String(p._id), Number(p.sowingBuffer) || 0]));

  return (requests || []).map((request) => {
    const sowingBuffer = plantBufferMap.get(String(request.plantId)) || 0;
    const baseSowingQty = Number(request.remainingSowingNeeded || request.packetsNeeded || 0) || 0;
    const displaySowingQty = applySowingBuffer(baseSowingQty, sowingBuffer);
    return {
      ...request,
      sowingBuffer,
      bufferPercent: sowingBuffer,
      baseSowingQty,
      displaySowingQty,
    };
  });
};

// Create Sowing Request from today's sowing cards
export const createSowingRequest = async (req, res) => {
  try {
    const {
      plantId,
      subtypeId,
      productId,
      packetsNeeded,
      packetsRequested,
      notes,
      slotIds,
      seedSource,
      packetsFromCompany,
      packetsFromRaising,
      raisingIntakeIds,
      linkedOrderIds,
    } = req.body;

    if (!plantId || !subtypeId || !packetsNeeded) {
      return res.status(400).json({
        success: false,
        message: 'plantId, subtypeId, and packetsNeeded are required',
      });
    }

    const fromCompany = Number(packetsFromCompany);
    const fromRaising = Number(packetsFromRaising);
    const hasSplit =
      (Number.isFinite(fromCompany) && fromCompany > 0) ||
      (Number.isFinite(fromRaising) && fromRaising > 0);

    // packetsRequested defaults to packetsNeeded if not provided
    const requested = hasSplit
      ? (Number.isFinite(fromCompany) ? fromCompany : 0) +
        (Number.isFinite(fromRaising) ? fromRaising : 0)
      : packetsRequested || packetsNeeded;
    const excess = Math.max(0, requested - packetsNeeded);

    let resolvedSource = seedSource || 'COMPANY';
    if (hasSplit) {
      if ((fromCompany || 0) > 0 && (fromRaising || 0) > 0) resolvedSource = 'MIXED';
      else if ((fromRaising || 0) > 0) resolvedSource = 'RAISING';
      else resolvedSource = 'COMPANY';
    }

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

    // Prefer explicit packing (productId) when subtype has multiple seed pack sizes
    let product = null;
    if (productId && mongoose.Types.ObjectId.isValid(productId)) {
      product = await Product.findOne({
        _id: new mongoose.Types.ObjectId(productId),
        plantId: new mongoose.Types.ObjectId(plantId),
        subtypeId: new mongoose.Types.ObjectId(subtypeId),
        category: { $regex: /^seeds$/i },
        isActive: true,
      })
        .select(
          '_id name code plantId subtypeId ramAgriCropId ramAgriVarietyId conversionFactor tentativePlantsPerPacket primaryUnit secondaryUnit'
        )
        .populate('primaryUnit', 'name symbol')
        .populate('secondaryUnit', 'name symbol')
        .lean();
      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Selected seed packing not found for this plant/subtype',
        });
      }
    } else {
      product = await Product.findOne({
        plantId: new mongoose.Types.ObjectId(plantId),
        subtypeId: new mongoose.Types.ObjectId(subtypeId),
        category: { $regex: /^seeds$/i },
        isActive: true,
      })
        .select(
          '_id name code plantId subtypeId ramAgriCropId ramAgriVarietyId conversionFactor tentativePlantsPerPacket primaryUnit secondaryUnit'
        )
        .populate('primaryUnit', 'name symbol')
        .populate('secondaryUnit', 'name symbol')
        .lean();
    }

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found for this plant and subtype',
      });
    }

    // Lock per packing while an active request exists (pending → issued / sowing)
    const existingRequest = await SowingRequest.findOne({
      plantId: new mongoose.Types.ObjectId(plantId),
      subtypeId: new mongoose.Types.ObjectId(subtypeId),
      productId: product._id,
      status: { $in: ['pending', 'processing', 'issued'] },
      sowingCompleted: { $ne: true },
    });

    if (existingRequest) {
      const msg =
        existingRequest.status === 'issued'
          ? `Stock already issued (${existingRequest.requestNumber}) — sowing in progress. Cannot request again for this packing.`
          : `A ${existingRequest.status} request already exists for this seed packing (${existingRequest.requestNumber})`;
      return res.status(400).json({
        success: false,
        message: msg,
        data: existingRequest,
      });
    }

    // Convert slotIds to ObjectIds if provided
    const linkedSlotIds = slotIds && Array.isArray(slotIds) 
      ? slotIds.map(id => new mongoose.Types.ObjectId(id))
      : [];

    const linkedOrderObjectIds = Array.isArray(linkedOrderIds)
      ? linkedOrderIds
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
          .map((id) => new mongoose.Types.ObjectId(id))
      : [];

    // Same order cannot be included in another active sowing request
    if (linkedOrderObjectIds.length) {
      const ACTIVE_REQ = ['pending', 'processing', 'issued'];
      const conflict = await SowingRequest.findOne({
        linkedOrderIds: { $in: linkedOrderObjectIds },
        status: { $in: ACTIVE_REQ },
      })
        .select('requestNumber status linkedOrderIds plantName subtypeName')
        .lean();

      if (conflict) {
        const conflictIds = new Set(
          (conflict.linkedOrderIds || []).map((id) => String(id))
        );
        const overlap = linkedOrderObjectIds.filter((id) =>
          conflictIds.has(String(id))
        );
        return res.status(400).json({
          success: false,
          message: `Order(s) already requested in ${conflict.requestNumber} (${conflict.status}). Cannot request again for the same order.`,
          data: {
            existingRequestNumber: conflict.requestNumber,
            existingStatus: conflict.status,
            overlappingOrderIds: overlap,
          },
        });
      }
    }

    // Generate request number
    const requestNumber = await SowingRequest.generateRequestNumber();

    const raisingNeed = hasSplit
      ? Number.isFinite(fromRaising)
        ? fromRaising
        : 0
      : 0;
    let raisingObjectIds = Array.isArray(raisingIntakeIds)
      ? raisingIntakeIds
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
          .map((id) => new mongoose.Types.ObjectId(id))
      : [];

    // Draw down customer-seed intakes (FIFO) when requesting raising packets
    let raisingAllocated = raisingNeed;
    if (raisingNeed > 0) {
      const { allocateRaisingPackets } = await import(
        "./raisingSeed.controller.js"
      );
      const alloc = await allocateRaisingPackets({
        plantId,
        subtypeId,
        packetsNeeded: raisingNeed,
        preferredIntakeIds: raisingObjectIds,
        linkedOrderIds: linkedOrderObjectIds,
      });
      const companyShare = hasSplit
        ? Number.isFinite(fromCompany)
          ? fromCompany
          : 0
        : 0;
      if (alloc.shortfall > 0.001 && companyShare <= 0) {
        return res.status(400).json({
          success: false,
          message: `Not enough raising seed in hand (need ${raisingNeed}, available ${alloc.allocated})`,
        });
      }
      raisingAllocated = alloc.allocated;
      raisingObjectIds = alloc.intakeIds.length
        ? alloc.intakeIds
        : raisingObjectIds;
    }

    const companyFinal = hasSplit
      ? Number.isFinite(fromCompany)
        ? fromCompany
        : 0
      : requested;
    const raisingFinal = hasSplit ? raisingAllocated : 0;
    const requestedFinal = hasSplit
      ? companyFinal + raisingFinal
      : requested;

    if (hasSplit) {
      if (companyFinal > 0 && raisingFinal > 0) resolvedSource = "MIXED";
      else if (raisingFinal > 0) resolvedSource = "RAISING";
      else resolvedSource = "COMPANY";
    }

    // Create request
    const request = new SowingRequest({
      requestNumber,
      plantId: new mongoose.Types.ObjectId(plantId),
      plantName: plant.name,
      subtypeId: new mongoose.Types.ObjectId(subtypeId),
      subtypeName: subtype.name,
      productId: product._id,
      packetsNeeded,
      packetsRequested: requestedFinal,
      excessPackets: Math.max(0, requestedFinal - packetsNeeded),
      primaryUnit: product.primaryUnit?._id,
      secondaryUnit: product.secondaryUnit?._id,
      conversionFactor: product.conversionFactor || 1,
      tentativePlantsPerPacket: resolveSowingPlantsPerPacket(product),
      unitName: product.primaryUnit?.symbol || product.primaryUnit?.name || product.secondaryUnit?.symbol || product.secondaryUnit?.name || 'packets',
      status: 'pending',
      requestedBy: req.user._id,
      linkedSlotIds,
      notes,
      seedSource: resolvedSource,
      packetsFromCompany: companyFinal,
      packetsFromRaising: raisingFinal,
      raisingIntakeIds: raisingObjectIds,
      linkedOrderIds: linkedOrderObjectIds,
    });

    await request.save();
    await request.populate(['primaryUnit', 'secondaryUnit', 'productId', 'requestedBy']);

    let transferResult = null;
    if (companyFinal > 0.001) {
      try {
        const { maybeCreateSowingTransferPurchaseOrder } = await import(
          '../services/sowingRamAgriTransfer.service.js'
        );
        transferResult = await maybeCreateSowingTransferPurchaseOrder({
          product,
          companyPackets: companyFinal,
          sowingRequest: request,
          userId: req.user._id,
        });
        if (transferResult?.purchaseOrder?._id) {
          request.transferPurchaseOrderId = transferResult.purchaseOrder._id;
          request.transferShortfallQty = transferResult.shortfall || 0;
          await request.save();
        }
      } catch (transferErr) {
        console.error('[CreateSowingRequest] Ram Agri transfer PO failed:', transferErr?.message || transferErr);
        transferResult = {
          error: transferErr?.message || 'Failed to create internal transfer PO',
        };
      }
    }

    try {
      const { bustTodaySowingCardsLiteCache } = await import(
        "./sowingCardsLite.controller.js"
      );
      bustTodaySowingCardsLiteCache();
    } catch (_) {
      /* optional cache bust */
    }

    res.status(201).json({
      success: true,
      message: 'Sowing request created successfully',
      data: request,
      transfer: transferResult
        ? {
            purchaseOrderId: transferResult.purchaseOrder?._id,
            poNumber: transferResult.purchaseOrder?.poNumber,
            shortfall: transferResult.shortfall,
            availableBefore: transferResult.availableBefore,
            skipped: transferResult.skipped,
            skipReason: transferResult.reason,
            error: transferResult.error,
          }
        : null,
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
      .populate('transferPurchaseOrderId', 'poNumber status')
      .sort({ requestedDate: -1 })
      .lean();

    // Get available stock for each request
    const requestsWithStock = await Promise.all(
      requests.map(async (request) => {
        let availablePackets = 0;
        try {
          const batches = await Batch.find({
            product: request.productId._id,
            status: { $in: ['active', 'expired'] },
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

    const requestsWithBuffer = await enrichRequestsWithBufferContext(requestsWithStock);

    res.json({
      success: true,
      data: requestsWithBuffer,
      count: requestsWithBuffer.length,
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
            status: { $in: ['active', 'expired'] },
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

    const requestsWithBuffer = await enrichRequestsWithBufferContext(requestsWithStock);

    res.json({
      success: true,
      data: requestsWithBuffer,
      count: requestsWithBuffer.length,
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

    // Get available batches for this product (warehouse / Ram Agri mirrors)
    const batches = await Batch.find({
      product: request.productId._id,
      status: { $in: ['active', 'expired'] },
      remainingQuantity: { $gt: 0 },
    })
      .select('batchNumber product receivedDate supplier purchasePrice quantity remainingQuantity unit status grn expiryDate manufactureDate')
      .populate('unit', 'name symbol')
      .populate('supplier', 'name')
      .sort({ receivedDate: 1 })
      .lean();

    // Calculate available packets from batches (warehouse)
    let availablePacketsFromBatches = 0;
    const primaryUnitId = request.primaryUnit?._id?.toString();
    const secondaryUnitId = request.secondaryUnit?._id?.toString();

    batches.forEach((batch) => {
      const batchUnitId = batch.unit?._id?.toString();
      if (batchUnitId === primaryUnitId) {
        availablePacketsFromBatches += batch.remainingQuantity;
      } else if (batchUnitId === secondaryUnitId && request.conversionFactor) {
        availablePacketsFromBatches += batch.remainingQuantity / request.conversionFactor;
      } else {
        availablePacketsFromBatches += batch.remainingQuantity;
      }
    });

    // Issued production outwards use purpose=production and status=issued (no InventoryOutward.type field).
    const outwardQuery = {
      purpose: 'production',
      status: 'issued',
    };
    if (request.outwardId) {
      outwardQuery._id = request.outwardId;
    } else {
      outwardQuery.sowingRequestId = request._id;
    }

    const outwardRecords = await InventoryOutward.find(outwardQuery)
      .populate({
        path: 'items.product',
        select: '_id',
      })
      .populate('items.unit', 'name symbol')
      .lean();

    let availablePacketsFromOutward = 0;
    
    outwardRecords.forEach((outward) => {
      outward.items?.forEach((item) => {
        // Check if this item is for our product
        if (item.product?._id?.toString() === request.productId._id.toString()) {
          const totalQty = item.quantity || 0;
          const usedQty = item.usedQuantity || 0;
          const availableQty = totalQty - usedQty; // Issued but not used yet
          
          if (availableQty > 0) {
            const itemUnitId = item.unit?._id?.toString();
            
            // Convert to secondary unit (packets) based on unit
            if (itemUnitId === primaryUnitId) {
              availablePacketsFromOutward += availableQty;
            } else if (itemUnitId === secondaryUnitId && request.conversionFactor) {
              availablePacketsFromOutward += availableQty / request.conversionFactor;
            } else {
              availablePacketsFromOutward += availableQty;
            }
          }
        }
      });
    });

    // Total available = warehouse stock + issued but unused
    const availablePackets = availablePacketsFromBatches + availablePacketsFromOutward;
    
    console.log(`[getSowingRequestById] Real-time stock calculation:`, {
      productId: request.productId._id,
      availablePacketsFromBatches,
      availablePacketsFromOutward,
      totalAvailable: availablePackets,
    });

    res.json({
      success: true,
      data: {
        ...request,
        /** Outward purpose used when issuing stock from this dialog (always production for sowing). */
        issuePurpose: 'production',
        availablePackets: Math.floor(availablePackets),
        availablePacketsFromBatches: Math.floor(availablePacketsFromBatches),
        availablePacketsFromOutward: Math.floor(availablePacketsFromOutward),
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
    const { batchAllocations: rawAllocations, notes, purpose = 'production' } = req.body;
    const batchAllocations = Array.isArray(rawAllocations) ? rawAllocations : [];

    if (purpose !== 'production') {
      return res.status(400).json({
        success: false,
        message: 'Sowing stock issue must use purpose "production" only.',
      });
    }

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

    // Warehouse issues company packets only; raising was allocated at create.
    const companyIssueQty = resolveCompanyIssuePackets(request);
    const packetsRequested =
      Number(request.packetsRequested || request.packetsNeeded) || companyIssueQty;
    let totalAllocated = 0;
    let outward = null;
    let excessPackets = 0;

    if (companyIssueQty < 0.01) {
      if (batchAllocations.length > 0) {
        return res.status(400).json({
          success: false,
          message:
            'This request has no company packets to issue (raising-only / zero company). Send empty batchAllocations.',
        });
      }
      // Raising-only: mark issued without warehouse outward.
      request.status = 'issued';
      request.issuedBy = req.user._id;
      request.issuedDate = new Date();
      request.packetsIssued = 0;
      request.excessPackets = 0;
      request.sowingInProgress = true;
      if (!request.sowingStartedDate) {
        request.sowingStartedDate = new Date();
      }
      await request.save();
    } else {
    // Validate batch allocations
    if (batchAllocations.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Batch allocations are required for company seed packets',
      });
    }

    // Calculate total quantity from allocations
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

      if (!['active', 'expired'].includes(batch.status)) {
        return res.status(400).json({
          success: false,
          message: `Batch ${batch.batchNumber} is not issuable (status: ${batch.status})`,
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

    // Must match company packets only (not company + raising)
    if (Math.abs(totalAllocated - companyIssueQty) > 0.01) {
      return res.status(400).json({
        success: false,
        message: `Total allocated quantity (${totalAllocated.toFixed(2)}) must exactly match company packets to issue (${companyIssueQty}). Raising packets (${Number(request.packetsFromRaising) || 0}) are not issued from warehouse.`,
      });
    }

    // Calculate excess packets vs needed company portion
    const companyNeeded =
      request.packetsFromCompany != null && Number.isFinite(Number(request.packetsFromCompany))
        ? Number(request.packetsFromCompany)
        : Math.max(0, Number(request.packetsNeeded) || 0);
    excessPackets = Math.max(0, totalAllocated - companyNeeded);

    // Create outward entry and issue stock directly
    const outwardNumber = await InventoryOutward.generateOutwardNumber();
    const outwardItems = batchAllocations.map((allocation) => {
      const item = {
        product: request.productId,
        batch: allocation.batchId,
        quantity: allocation.quantity,
        unit: request.primaryUnit || request.secondaryUnit,
        notes: allocation.notes || notes,
      };
      
      // Add expiry date if provided
      if (allocation.expiryDate) {
        item.expiryDate = new Date(allocation.expiryDate);
      }
      
      return item;
    });

    outward = new InventoryOutward({
      outwardNumber,
      outwardDate: new Date(),
      purpose,
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
    const createOutwardTransaction = async (item, outwardDoc, user) => {
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
        referenceId: outwardDoc._id,
        referenceNumber: outwardDoc.outwardNumber,
        fromLocation: 'Main Warehouse',
        toLocation: outwardDoc.destination || outwardDoc.department,
        reason: outwardDoc.purpose,
        remarks: outwardDoc.purposeDetails,
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

      if (!['active', 'expired'].includes(batch.status)) {
        throw new Error(`Batch ${batch.batchNumber} is not issuable (status: ${batch.status})`);
      }

      // Update batch
      batch.remainingQuantity -= item.quantity;
      if (batch.remainingQuantity <= 0) {
        batch.status = 'exhausted';
      }
      await batch.save();

      // If this Product is linked to Ram Agri, deduct source lot + resync product.currentStock
      let ramAgriLinked = false;
      try {
        const { deductLinkedRamAgriBatchForClassicBatch, isRamAgriLinkedProduct } =
          await import('../services/ramAgriLinkedProductSync.service.js');
        ramAgriLinked = isRamAgriLinkedProduct(product);
        if (ramAgriLinked) {
          await deductLinkedRamAgriBatchForClassicBatch(
            batch,
            item.quantity,
            req.user._id
          );
          const refreshed = await Product.findById(product._id);
          if (refreshed) {
            product.currentStock = refreshed.currentStock;
            product.stockValue = refreshed.stockValue;
            product.averagePrice = refreshed.averagePrice;
          }
        }
      } catch (linkErr) {
        console.error('[IssueStock] Ram Agri linked deduct failed:', linkErr?.message || linkErr);
        throw linkErr;
      }

      if (!ramAgriLinked) {
        // Classic-only product: deduct Product.currentStock here
        if (product.currentStock < item.quantity) {
          throw new Error(
            `Insufficient stock. Available: ${product.currentStock}, Required: ${item.quantity}`
          );
        }
        product.currentStock -= item.quantity;
        if (product.currentStock > 0 && product.stockValue > 0) {
          product.averagePrice = product.stockValue / product.currentStock;
        } else {
          product.averagePrice = 0;
        }
        product.updatedBy = req.user._id;
        await product.save();
      }

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
    request.packetsIssued = totalAllocated;
    request.excessPackets = excessPackets;
    request.sowingInProgress = true; // Mark sowing as in progress when stock is issued
    if (!request.sowingStartedDate) {
      request.sowingStartedDate = new Date(); // Set start date if not already set
    }
    await request.save();
    } // end companyIssueQty > 0

    // Packets for slot sowingInProgress: full request (company + raising) when available
    const packetsForSlots = Math.max(companyIssueQty, packetsRequested) || packetsRequested;

    // Update slots' sowingInProgress array - DISTRIBUTE BASED ON EACH SLOT'S GAP
    /** @type {{ slotsWritten: number, plantSlotDocsSaved: number, fallbackUsed: boolean }} */
    const slotLinkage = { slotsWritten: 0, plantSlotDocsSaved: 0, fallbackUsed: false };
    if (request.linkedSlotIds && request.linkedSlotIds.length > 0) {
      const plantsPerPacket = resolveSowingPlantsPerPacket(request);
      
      console.log(`[IssueStock] Distributing ${packetsForSlots} packets across ${request.linkedSlotIds.length} slots based on each slot's gap`);
      
      // Step 1: Fetch all unique PlantSlot documents ONCE (avoid multiple instances of same document)
      const plantSlotsMap = new Map(); // Map<plantSlotId, plantSlotDoc>
      
      for (const slotId of request.linkedSlotIds) {
        try {
          const plantSlot = await PlantSlot.findOne({
            'subtypeSlots.slots._id': slotId,
          });
          
          if (plantSlot) {
            const plantSlotId = plantSlot._id.toString();
            if (!plantSlotsMap.has(plantSlotId)) {
              plantSlotsMap.set(plantSlotId, plantSlot);
            }
          }
        } catch (err) {
          console.error(`[IssueStock] Error fetching PlantSlot for slot ${slotId}:`, err);
        }
      }
      
      // Step 2: Build slotGaps array from unique PlantSlot documents
      const slotGaps = [];
      let totalGap = 0;
      const isExcessiveSowing = request.isExcessiveSowing || false;
      
      // Get sowing buffer from PlantCms (fetch once)
      const plant = await PlantCms.findById(request.plantId).select('sowingBuffer');
      const sowingBuffer = plant?.sowingBuffer || 0;
      
      console.log(`[IssueStock] ==========================================`);
      console.log(`[IssueStock] Processing ${request.linkedSlotIds.length} linked slots:`, request.linkedSlotIds.map(id => id.toString()));
      console.log(`[IssueStock] isExcessiveSowing: ${isExcessiveSowing}`);
      console.log(`[IssueStock] ==========================================`);
      
      for (const slotId of request.linkedSlotIds) {
        try {
          console.log(`[IssueStock] 🔍 Looking for slot ${slotId} in PlantSlot documents...`);
          // Find the slot in the unique PlantSlot documents
          let foundSlot = null;
          let foundPlantSlot = null;
          let foundSubtypeSlot = null;
          
          for (const [plantSlotId, plantSlot] of plantSlotsMap.entries()) {
            for (const subtypeSlot of plantSlot.subtypeSlots) {
              const slot = subtypeSlot.slots.find(s => s._id.toString() === slotId.toString());
              if (slot) {
                foundSlot = slot;
                foundPlantSlot = plantSlot;
                foundSubtypeSlot = subtypeSlot;
                console.log(`[IssueStock] ✅ Found slot ${slotId} in PlantSlot ${plantSlotId}, subtypeSlot ${subtypeSlot.subtypeId}`);
                break;
              }
            }
            if (foundSlot) break;
          }
          
          if (foundSlot) {
            let gap, rawGap;
            
            if (isExcessiveSowing) {
              // For excessive sowing: allocate ALL packets to this specific slot (linked based on creation date)
              // No gap calculation needed - just track the slot for allocation
              rawGap = 0; // No gap for excessive sowing
              gap = 1; // Use 1 as weight - will allocate all packets to this slot
              console.log(`[IssueStock] [EXCESSIVE] Slot ${slotId}: Linked slot for excessive sowing, will allocate ALL ${packetsForSlots} packets to this slot`);
            } else {
              // Calculate gap for this slot (including buffer if applicable)
              const totalBookedPlants = foundSlot.totalBookedPlants || 0;
              const primarySowed = foundSlot.primarySowed || 0;
              rawGap = totalBookedPlants - primarySowed;
              gap = Math.ceil(rawGap * (1 + sowingBuffer / 100));
              console.log(`[IssueStock] ✅ Slot ${slotId}: Added to slotGaps. Gap=${gap} plants (raw: ${rawGap}, buffer: ${sowingBuffer}%)`);
            }
            
            slotGaps.push({
              slotId: slotId,
              slot: foundSlot,
              plantSlot: foundPlantSlot,
              subtypeSlot: foundSubtypeSlot,
              gap: gap,
              rawGap: rawGap,
              isExcessiveSowing: isExcessiveSowing
            });
            
            if (!isExcessiveSowing) {
              totalGap += gap;
            }
          } else {
            console.error(`[IssueStock] ❌ Slot ${slotId} NOT FOUND in PlantSlot documents! Cannot add sowingInProgress entry.`);
          }
        } catch (err) {
          console.error(`[IssueStock] ❌ Error processing slot ${slotId}:`, err);
        }
      }
      
      console.log(`[IssueStock] ==========================================`);
      console.log(`[IssueStock] 📊 SUMMARY: Processed ${request.linkedSlotIds.length} linked slots, found ${slotGaps.length} slots in slotGaps array`);
      console.log(`[IssueStock] 📋 slotGaps array contains:`, slotGaps.map(s => ({ slotId: s.slotId.toString(), gap: s.gap, isExcessive: s.isExcessiveSowing })));
      console.log(`[IssueStock] ==========================================`);
      
      if (!isExcessiveSowing) {
        console.log(`[IssueStock] Total gap across all slots: ${totalGap} plants`);
      }

      // Fallback: linkedSlotIds present but no slot resolved into slotGaps (ID mismatch / not found).
      // Attach full issue to first linked slot so sowingInProgress + today-sowing-cards stay in sync.
      if (slotGaps.length === 0 && request.linkedSlotIds && request.linkedSlotIds.length > 0) {
        const fallbackSlotId = request.linkedSlotIds[0];
        try {
          const plantSlotDoc = await PlantSlot.findOne({
            'subtypeSlots.slots._id': fallbackSlotId,
          });
          if (plantSlotDoc) {
            for (const subtypeSlot of plantSlotDoc.subtypeSlots || []) {
              const slot = (subtypeSlot.slots || []).find(
                (s) => s._id.toString() === fallbackSlotId.toString()
              );
              if (slot) {
                slotGaps.push({
                  slotId: fallbackSlotId,
                  slot,
                  plantSlot: plantSlotDoc,
                  subtypeSlot,
                  gap: Math.max(1, packetsForSlots * plantsPerPacket),
                  rawGap: 0,
                  isExcessiveSowing: isExcessiveSowing,
                });
                slotLinkage.fallbackUsed = true;
                console.warn(
                  `[IssueStock] Fallback: single slot ${fallbackSlotId} — full ${packetsForSlots} pkt for today-sowing linkage`
                );
                break;
              }
            }
          } else {
            console.error(`[IssueStock] Fallback failed: no PlantSlot for slot ${fallbackSlotId}`);
          }
        } catch (fbErr) {
          console.error('[IssueStock] Fallback slot attach error:', fbErr);
        }
      }
      
      // Step 2: Distribute packets/plants based on slot gaps (or allocate all to specific slot for excessive sowing)
      let remainingPackets = packetsForSlots;
      let remainingPlants = packetsForSlots * plantsPerPacket;
      
      // Step 3: Group slots by their parent PlantSlot document to avoid version conflicts
      const plantSlotUpdates = new Map(); // Map<plantSlotId, {plantSlot, slotsToUpdate: []}>
      
      for (let i = 0; i < slotGaps.length; i++) {
        const slotData = slotGaps[i];
        const isLastSlot = i === slotGaps.length - 1;
        
        // Calculate this slot's share
        let slotPackets, slotPlants;
        
        if (slotData.isExcessiveSowing) {
          // For excessive sowing: allocate ALL packets to this specific slot (linked based on creation date)
          // Excessive sowing requests are linked to one specific slot calculated from the sowing date
          slotPackets = packetsForSlots; // All packets go to this slot
          slotPlants = packetsForSlots * plantsPerPacket; // All plants go to this slot
          console.log(`[IssueStock] [EXCESSIVE] Slot ${slotData.slotId}: Allocating ALL ${slotPackets} packets, ${slotPlants} plants to this linked slot (based on creation date)`);
        } else {
          // Regular sowing: proportional distribution based on gap
          if (isLastSlot) {
            // Last slot gets remaining (to handle rounding)
            slotPackets = remainingPackets;
            slotPlants = remainingPlants;
          } else {
            // Proportional distribution: (slot gap / total gap) × total packets
            const proportion = totalGap > 0 ? slotData.gap / totalGap : 1 / slotGaps.length;
            slotPackets = packetsForSlots * proportion;
            slotPlants = slotData.gap; // Booking-gap plants for this slot
            // If gap is 0 but this slot still got a packet share, expected plants must come from packets × CF
            if (slotPackets > 0 && (!slotPlants || slotPlants <= 0)) {
              slotPlants = slotPackets * plantsPerPacket;
            }
            remainingPackets -= slotPackets;
            remainingPlants -= slotPlants;
          }
          console.log(`[IssueStock] Slot ${slotData.slotId}: Allocating ${slotPackets} packets, ${slotPlants} plants (proportional to gap)`);
        }
        
        // Round packets to 2 decimal places
        slotPackets = Math.round(slotPackets * 100) / 100;
        // After rounding, re-sync plants if gap was 0
        if (!slotData.isExcessiveSowing && slotPackets > 0 && (!slotPlants || slotPlants <= 0)) {
          slotPlants = Math.round(slotPackets * plantsPerPacket * 100) / 100;
        }
        
        // Group by plantSlot document
        const plantSlotId = slotData.plantSlot._id.toString();
        if (!plantSlotUpdates.has(plantSlotId)) {
          plantSlotUpdates.set(plantSlotId, {
            plantSlot: slotData.plantSlot,
            slotsToUpdate: []
          });
        }
        
        plantSlotUpdates.get(plantSlotId).slotsToUpdate.push({
          slot: slotData.slot,
          slotId: slotData.slotId,
          slotPackets,
          slotPlants
        });
      }
      
      // Step 4: Update all slots within each PlantSlot document, then save once per document
      console.log(`[IssueStock] Step 4: Updating ${plantSlotUpdates.size} PlantSlot document(s) with ${Array.from(plantSlotUpdates.values()).reduce((sum, data) => sum + data.slotsToUpdate.length, 0)} total slot(s)`);
      
      for (const [plantSlotId, updateData] of plantSlotUpdates.entries()) {
        const { plantSlot, slotsToUpdate } = updateData;
        console.log(`[IssueStock] 📦 Processing PlantSlot ${plantSlotId} with ${slotsToUpdate.length} slot(s) to update`);
        
        for (const { slot, slotId, slotPackets, slotPlants } of slotsToUpdate) {
          console.log(`[IssueStock] 🔄 Processing slot ${slotId}: packets=${slotPackets}, plants=${slotPlants}`);
          
          // Initialize sowingInProgress as array if needed
          if (typeof slot.sowingInProgress === 'boolean') {
            slot.sowingInProgress = [];
          }
          if (!Array.isArray(slot.sowingInProgress)) {
            slot.sowingInProgress = [];
          }
          
          const previousProgressLength = slot.sowingInProgress.length;
          
          const impliedPlantsFromPackets =
            slotPackets > 0 ? Math.round(slotPackets * plantsPerPacket * 100) / 100 : 0;
          const sowingProgressEntry = {
            requestNumber: request.requestNumber,
            packetsIssued: slotPackets,
            plantsExpected:
              slotPlants > 0 ? slotPlants : impliedPlantsFromPackets,
            outwardId: outward._id,
            sowingRequestId: request._id,
            isExcessiveSowing: request.isExcessiveSowing || false,
            issuedDate: new Date(),
          };
          
          slot.sowingInProgress.push(sowingProgressEntry);
          console.log(`[IssueStock] ✅ Slot ${slotId}: Added sowingInProgress entry (was ${previousProgressLength}, now ${slot.sowingInProgress.length})`);
          
          // Add trail entry
          slot.slotTrail = slot.slotTrail || [];
          slot.slotTrail.push({
            action: 'STOCK_REQUEST_ISSUED',
            quantity: slotPackets,
            previousTotalPlants: slot.totalPlants || 0,
            newTotalPlants: slot.totalPlants || 0,
            previousAvailablePlants: slot.availablePlants || 0,
            newAvailablePlants: slot.availablePlants || 0,
            reason: `Stock issued for ${request.requestNumber}: ${slotPackets} packets (${slotPlants} plants expected) - Part of ${request.linkedSlotIds.length} slot request`,
            sowingRequestId: request._id,
            performedBy: req.user._id,
            notes: `Outward: ${outward.outwardNumber}`,
          });
        }
        
        // Save plantSlot once with all slot updates
        try {
          // Verify slots before save
          console.log(`[IssueStock] 🔍 Before save - Verifying ${slotsToUpdate.length} slot(s) in PlantSlot ${plantSlotId}:`);
          slotsToUpdate.forEach(({ slot, slotId, slotPackets }) => {
            const progressLength = slot?.sowingInProgress?.length || 0;
            const lastEntry = progressLength > 0 ? slot.sowingInProgress[progressLength - 1] : null;
            console.log(`[IssueStock]   Slot ${slotId}: sowingInProgress.length=${progressLength}, lastEntry.requestNumber=${lastEntry?.requestNumber || 'N/A'}`);
          });
          
          plantSlot.markModified('subtypeSlots');
          await plantSlot.save();
          slotLinkage.plantSlotDocsSaved += 1;
          slotLinkage.slotsWritten += slotsToUpdate.length;
          
          console.log(`[IssueStock] ✅ PlantSlot ${plantSlotId} saved successfully with ${slotsToUpdate.length} slot(s) updated`);
          
          // Verify slots after save by re-fetching
          const savedPlantSlot = await PlantSlot.findById(plantSlotId);
          if (savedPlantSlot) {
            console.log(`[IssueStock] 🔍 After save - Verifying slots in database:`);
            slotsToUpdate.forEach(({ slotId: checkSlotId }) => {
              let found = false;
              for (const subtypeSlot of savedPlantSlot.subtypeSlots) {
                const savedSlot = subtypeSlot.slots.id(checkSlotId);
                if (savedSlot) {
                  const savedProgressLength = savedSlot.sowingInProgress?.length || 0;
                  const savedLastEntry = savedProgressLength > 0 ? savedSlot.sowingInProgress[savedProgressLength - 1] : null;
                  console.log(`[IssueStock]   ✅ Slot ${checkSlotId}: sowingInProgress.length=${savedProgressLength}, lastEntry.requestNumber=${savedLastEntry?.requestNumber || 'N/A'}`);
                  found = true;
                  break;
                }
              }
              if (!found) {
                console.error(`[IssueStock]   ❌ Slot ${checkSlotId}: NOT FOUND in saved document!`);
              }
            });
          }
          
          // Log details of each slot that was updated
          slotsToUpdate.forEach(({ slot, slotId, slotPackets }) => {
            const progressLength = slot?.sowingInProgress?.length || 0;
            console.log(`[IssueStock] 📊 Slot ${slotId}: Added ${slotPackets} packets, sowingInProgress.length=${progressLength}`);
          });
        } catch (err) {
          console.error(`[IssueStock] ❌ Error saving PlantSlot ${plantSlotId}:`, err);
          console.error(`[IssueStock] ❌ Error stack:`, err.stack);
        }
      }
      
      console.log(`[IssueStock] ✅ Distribution complete: ${packetsForSlots} packets distributed across ${slotGaps.length} slots`);
    }

    await request.populate(['primaryUnit', 'secondaryUnit', 'productId', 'issuedBy', 'outwardId']);

    res.json({
      success: true,
      message:
        companyIssueQty < 0.01
          ? 'Raising-only request marked issued (no warehouse stock)'
          : 'Stock issued successfully from sowing request',
      data: {
        request,
        outward,
        slotLinkage: {
          linkedSlotIdsCount: request.linkedSlotIds?.length || 0,
          ...slotLinkage,
          note:
            request.linkedSlotIds?.length && slotLinkage.slotsWritten === 0
              ? 'No slot.sowingInProgress rows written — check server logs (slot IDs must exist under PlantSlot.subtypeSlots.slots). Today-sowing-cards inProgressCards may be empty until fixed.'
              : undefined,
        },
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

// Cancel sowing request (supports both pending and issued requests)
export const cancelSowingRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const request = await SowingRequest.findById(id)
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

    // If no stock was issued, just mark as cancelled
    if (!request.outwardId) {
      request.status = 'cancelled';
      request.cancelledBy = req.user?._id;
      request.cancelledDate = new Date();
      request.cancellationReason = reason || 'Request cancelled before stock issuance';
      await request.save();

      return res.json({
        success: true,
        message: 'Sowing request cancelled successfully (no stock was issued)',
        data: request,
      });
    }

    // Stock was issued - need to revert everything
    console.log(`🔄 Cancelling issued sowing request ${request.requestNumber}...`);

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
          if (batch.status === 'exhausted' && batch.remainingQuantity > 0) {
            batch.status = 'active';
          }
          await batch.save();
          
          // Update product currentStock
          const product = await Product.findById(item.product);
          if (product) {
            const previousStock = product.currentStock || 0;
            product.currentStock = previousStock + item.quantity;
            if (product.currentStock > 0 && product.stockValue > 0) {
              product.averagePrice = product.stockValue / product.currentStock;
            }
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

          // Create return transaction
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
            performedBy: req.user?._id,
            metadata: {
              sowingRequestId: request._id,
              sowingRequestNumber: request.requestNumber,
              cancelledBy: req.user?._id,
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
                  performedBy: req.user?._id,
                  notes: `Cancelled: ${progressEntry.packetsIssued} packets (${progressEntry.plantsExpected} plants) returned to inventory`,
                });

                plantSlotDoc.markModified('subtypeSlots');
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
    outward.cancelledBy = req.user?._id;
    outward.cancelledDate = new Date();
    outward.notes = `${outward.notes || ''}\n[CANCELLED] ${reason || 'Sowing request cancelled'}`.trim();
    await outward.save();

    // Step 5: Mark request as cancelled
    request.status = 'cancelled';
    request.sowingInProgress = false;
    request.cancelledBy = req.user?._id;
    request.cancelledDate = new Date();
    request.cancellationReason = reason || 'Sowing request cancelled';
    await request.save();

    console.log(`✅ Successfully cancelled sowing request ${request.requestNumber}`);

    return res.json({
      success: true,
      message: 'Sowing request cancelled successfully. All changes reverted.',
      data: {
        request: {
          _id: request._id,
          requestNumber: request.requestNumber,
          status: request.status,
          plantName: request.plantId?.name,
          subtypeName: request.subtypeId?.name,
          packetsRequested: request.packetsRequested,
          cancelledBy: req.user?._id,
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
      },
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

      const [requestWithBuffer] = await enrichRequestsWithBufferContext([{
        ...request,
        isIssuedToday,
      }]);

      return res.json({
        success: true,
        exists: true,
        data: {
          ...requestWithBuffer,
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
