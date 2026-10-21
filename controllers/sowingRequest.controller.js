import SowingRequest from '../models/sowingRequest.model.js';
import Product from '../models/product.model.js';
import PlantCms from '../models/plantCms.model.js';
import InventoryOutward from '../models/inventoryOutward.model.js';
import Batch from '../models/batch.model.js';
import InventoryTransaction from '../models/inventoryTransaction.model.js';
import PlantSlot from '../models/slots.model.js';
import Order from '../models/order.model.js';
import RaisingSeedIntake from '../models/raisingSeedIntake.model.js';
import mongoose from 'mongoose';
import { resolveSowingPlantsPerPacket } from '../utility/sowingPlantsPerPacket.js';
import { validateLinkedOrderScope } from '../utility/sowingRequestOrderScope.js';
import { insertTrailRows } from '../utility/slotTrailStore.js';
import { getSlotTrailActivityName } from '../constants/slotTrailActions.js';

const applySowingBuffer = (baseValue, bufferPercent) => {
  const qty = Number(baseValue) || 0;
  const buffer = Number(bufferPercent) || 0;
  return buffer > 0 ? Math.round(qty * (1 + buffer / 100)) : qty;
};

/** Bust Request Packets / Sowing in progress cards cache (2min TTL). */
function bustSowingCardsLiteCache() {
  setImmediate(() => {
    import("./sowingCardsLite.controller.js")
      .then((m) => m.bustTodaySowingCardsLiteCache?.())
      .catch(() => {});
  });
}

async function issuePendingRequestDirect(requestDoc, user, { cancelOnFail = true } = {}) {
  const { buildDirectIssueBody, abandonUnissuedRequest } = await import(
    "../services/directIssueSowingRequest.service.js"
  );
  const request = await SowingRequest.findById(requestDoc._id)
    .populate("primaryUnit", "name symbol")
    .populate("secondaryUnit", "name symbol")
    .populate("productId");
  if (!request) {
    return { success: false, statusCode: 404, message: "Sowing request not found" };
  }
  if (request.status === "issued") {
    return { success: true, statusCode: 200, data: { request }, alreadyIssued: true };
  }
  try {
    const built = await buildDirectIssueBody(request);
    if (!built.ok) {
      return {
        success: false,
        statusCode: 400,
        message: built.message || "Could not issue sowing request",
      };
    }
    const issued = await invokeIssueStock(request._id, built.body, user);
    if (!issued.success) {
      if (cancelOnFail) {
        await abandonUnissuedRequest(
          request._id,
          user,
          issued.message || "Could not issue sowing request"
        );
      }
      return {
        success: false,
        statusCode: 400,
        message: issued.message || "Could not issue sowing request",
      };
    }
    return {
      success: true,
      statusCode: 201,
      data: issued.data,
      message: "Sowing request created and issued",
    };
  } catch (issueErr) {
    if (cancelOnFail) {
      await abandonUnissuedRequest(
        request._id,
        user,
        issueErr?.message || "Could not issue sowing request"
      );
    }
    return {
      success: false,
      statusCode: 400,
      message: issueErr?.message || "Could not issue sowing request",
    };
  }
}

/** Run the stock-issue handler in-process and capture its JSON response. */
function invokeIssueStock(requestId, body, user) {
  return new Promise((resolve) => {
    let settled = false;
    const fakeRes = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        if (settled) return payload;
        settled = true;
        const ok = payload?.success !== false && this.statusCode < 400;
        resolve({
          success: ok,
          statusCode: this.statusCode,
          message: payload?.message,
          data: payload?.data,
        });
        return payload;
      },
    };
    Promise.resolve(
      issueStockFromRequest(
        { params: { id: String(requestId) }, body, user },
        fakeRes
      )
    ).catch((err) => {
      if (!settled) {
        resolve({ success: false, message: err?.message || "Failed to issue stock" });
      }
    });
  });
}

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

const restoreCancelledRequestRaisingPackets = async (request) => {
  const packets = Math.max(0, Number(request?.packetsFromRaising) || 0);
  const intakeIds = request?.raisingIntakeIds || [];
  if (!packets || !intakeIds.length) return { restored: 0 };
  const { restoreRaisingPackets } = await import("./raisingSeed.controller.js");
  return restoreRaisingPackets({
    intakeIds,
    packetsToRestore: packets,
  });
};

const enrichRequestsWithBufferContext = async (requests) => {
  const plantIds = [...new Set((requests || []).map((r) => String(r.plantId)).filter(Boolean))]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const plants = await PlantCms.find({ _id: { $in: plantIds } })
    .select("_id sowingBuffer sowingMortality")
    .lean();
  const plantBufferMap = new Map(
    plants.map((p) => [
      String(p._id),
      {
        sowingBuffer: Number(p.sowingBuffer) || 0,
        sowingMortality: Number(p.sowingMortality) || 10,
      },
    ])
  );

  return (requests || []).map((request) => {
    const plantRates = plantBufferMap.get(String(request.plantId)) || {
      sowingBuffer: 0,
      sowingMortality: 10,
    };
    const sowingBuffer = plantRates.sowingBuffer;
    const sowingMortality = plantRates.sowingMortality;
    const baseSowingQty = Number(request.remainingSowingNeeded || request.packetsNeeded || 0) || 0;
    const displaySowingQty = applySowingBuffer(baseSowingQty, sowingBuffer);
    return {
      ...request,
      sowingBuffer,
      sowingMortality,
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
      isExcessiveSowing,
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
      if (req.body.directIssue) {
        const extraOrders = Array.isArray(linkedOrderIds)
          ? linkedOrderIds.filter((id) => mongoose.Types.ObjectId.isValid(id))
          : [];
        if (extraOrders.length) {
          await SowingRequest.updateOne(
            { _id: existingRequest._id },
            { $addToSet: { linkedOrderIds: { $each: extraOrders } } }
          );
        }
        if (existingRequest.status === "issued") {
          bustSowingCardsLiteCache();
          return res.status(200).json({
            success: true,
            message: `Already issued (${existingRequest.requestNumber}) — ready to sow`,
            data: existingRequest,
            directIssued: true,
          });
        }
        const issued = await issuePendingRequestDirect(existingRequest, req.user, {
          cancelOnFail: false,
        });
        bustSowingCardsLiteCache();
        return res.status(issued.statusCode || (issued.success ? 201 : 400)).json({
          success: issued.success,
          message: issued.success
            ? `Issued ${existingRequest.requestNumber} — ready to sow`
            : issued.message,
          data: issued.data?.request || existingRequest,
          directIssued: Boolean(issued.success),
        });
      }
      const unusedPending =
        ["pending", "processing"].includes(existingRequest.status) &&
        !existingRequest.outwardId &&
        !(Number(existingRequest.packetsIssued) > 0);
      if (unusedPending) {
        await restoreCancelledRequestRaisingPackets(existingRequest);
        existingRequest.status = "cancelled";
        existingRequest.cancelledBy = req.user?._id;
        existingRequest.cancelledDate = new Date();
        existingRequest.cancellationReason = "Replaced by a new packet request";
        await existingRequest.save();
        bustSowingCardsLiteCache();
      } else {
        const msg =
          existingRequest.status === "issued"
            ? `Stock already issued (${existingRequest.requestNumber}) — sowing in progress. Cannot request again for this packing.`
            : `A ${existingRequest.status} request already exists for this seed packing (${existingRequest.requestNumber})`;
        return res.status(400).json({
          success: false,
          message: msg,
          data: existingRequest,
        });
      }
    }

    const suppliedOrderIds = Array.isArray(linkedOrderIds)
      ? [...new Set(linkedOrderIds.map(String))]
      : [];
    const invalidOrderIds = suppliedOrderIds.filter(
      (id) => !mongoose.Types.ObjectId.isValid(id)
    );
    if (invalidOrderIds.length) {
      return res.status(400).json({
        success: false,
        message: 'One or more selected order IDs are invalid',
        data: { invalidOrderIds },
      });
    }

    const linkedOrderObjectIds = suppliedOrderIds.map(
      (id) => new mongoose.Types.ObjectId(id)
    );
    let linkedSlotIds = [];

    if (linkedOrderObjectIds.length) {
      const linkedOrders = await Order.find({
        _id: { $in: linkedOrderObjectIds },
      })
        .select('_id plantName plantSubtype bookingSlot orderStatus sowingDone')
        .lean();
      const orderScope = validateLinkedOrderScope({
        requestedOrderIds: suppliedOrderIds,
        orders: linkedOrders,
        plantId,
        subtypeId,
      });

      if (!orderScope.valid) {
        return res.status(400).json({
          success: false,
          message: orderScope.message,
          data: orderScope,
        });
      }

      linkedSlotIds = orderScope.linkedSlotIds.map(
        (id) => new mongoose.Types.ObjectId(id)
      );
    } else {
      linkedSlotIds = Array.isArray(slotIds)
        ? [...new Set(slotIds.map(String))]
            .filter((id) => mongoose.Types.ObjectId.isValid(id))
            .map((id) => new mongoose.Types.ObjectId(id))
        : [];
    }

    // Move overlapping orders off any other active request so this create can own them
    if (linkedOrderObjectIds.length) {
      const ACTIVE_REQ = ["pending", "processing", "issued"];
      await SowingRequest.updateMany(
        {
          linkedOrderIds: { $in: linkedOrderObjectIds },
          status: { $in: ACTIVE_REQ },
          sowingCompleted: { $ne: true },
        },
        {
          $pull: {
            linkedOrderIds: { $in: linkedOrderObjectIds },
            uncoveredOrderIds: { $in: linkedOrderObjectIds },
          },
        }
      );
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
      isExcessiveSowing: Boolean(isExcessiveSowing),
    });

    await request.saveWithUniqueRequestNumber();
    await request.populate(['primaryUnit', 'secondaryUnit', 'productId', 'requestedBy']);

    if (req.body.directIssue) {
      try {
        const issued = await issuePendingRequestDirect(request, req.user);
        bustSowingCardsLiteCache();
        if (!issued.success) {
          return res.status(issued.statusCode || 400).json({
            success: false,
            message: issued.message || "Could not issue sowing request",
          });
        }
        return res.status(201).json({
          success: true,
          message: "Sowing request created and issued",
          data: issued.data?.request || request,
          directIssued: true,
        });
      } catch (issueErr) {
        bustSowingCardsLiteCache();
        return res.status(400).json({
          success: false,
          message: issueErr?.message || "Could not issue sowing request",
        });
      }
    }

    // Auto Ram Agri → Biotech transfer on create is DISABLED so Office Admin
    // chooses Biotech / Input / Both at issue time (avoids double stock moves).
    const transferResult = null;

    bustSowingCardsLiteCache();

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

    // Completed / backfilled sow requests may have no seed product linked.
    const productOid =
      request.productId?._id ||
      (request.productId && mongoose.Types.ObjectId.isValid(request.productId)
        ? request.productId
        : null);

    let batches = [];
    let availablePacketsFromBatches = 0;
    let availablePacketsFromOutward = 0;

    if (productOid) {
      const { loadBiotechIssueBatches, packetsInRequestUnit } = await import(
        '../services/sowingIssueInventory.service.js'
      );
      batches = await loadBiotechIssueBatches({
        plantId: request.plantId,
        subtypeId: request.subtypeId,
        fallbackProductId: productOid,
      });
      const productIdStr = String(productOid);
      const primaryUnitId = request.primaryUnit?._id?.toString();
      const secondaryUnitId = request.secondaryUnit?._id?.toString();

      batches.forEach((batch) => {
        availablePacketsFromBatches += packetsInRequestUnit(batch, request);
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

      outwardRecords.forEach((outward) => {
        outward.items?.forEach((item) => {
          if (item.product?._id?.toString() === productIdStr) {
            const totalQty = item.quantity || 0;
            const usedQty = item.usedQuantity || 0;
            const availableQty = totalQty - usedQty;

            if (availableQty > 0) {
              const itemUnitId = item.unit?._id?.toString();

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
    }

    // Total available = warehouse stock + issued but unused
    const availablePackets = availablePacketsFromBatches + availablePacketsFromOutward;

    let inventoryAvailability = null;
    try {
      const { buildIssueInventoryAvailability } = await import(
        '../services/sowingIssueInventory.service.js'
      );
      inventoryAvailability = await buildIssueInventoryAvailability(
        request.plantId,
        request.subtypeId,
        productOid || request.productId
      );
    } catch (availErr) {
      console.error('[getSowingRequestById] inventoryAvailability:', availErr?.message || availErr);
    }
    const raisingIntakes = request.raisingIntakeIds?.length
      ? await RaisingSeedIntake.find({
          _id: { $in: request.raisingIntakeIds },
        })
          .select(
            "intakeNumber orderId farmerName packetsReceived packetsRemaining batchNumber batches expiryDate status"
          )
          .lean()
      : [];

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
        inventoryAvailability,
        raisingIntakes,
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

/**
 * Append a sowingInProgress entry to each linked slot, split by booking gap.
 * Reads only the needed slot fields and writes with targeted array updates
 * instead of loading and re-saving the whole plant-year PlantSlot document.
 */
const linkIssuedRequestToSlots = async ({ request, outward, packetsForSlots, userId }) => {
  const slotLinkage = { slotsWritten: 0, plantSlotDocsSaved: 0, fallbackUsed: false };
  const slotOids = (request.linkedSlotIds || [])
    .map((id) => String(id))
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!slotOids.length) return slotLinkage;

  const plantsPerPacket = resolveSowingPlantsPerPacket(request);
  const isExcessiveSowing = request.isExcessiveSowing || false;

  const [slotRows, plant] = await Promise.all([
    PlantSlot.aggregate([
      { $match: { 'subtypeSlots.slots._id': { $in: slotOids } } },
      {
        $project: {
          plantId: 1,
          year: 1,
          subtypeSlots: {
            $map: {
              input: '$subtypeSlots',
              as: 'st',
              in: {
                subtypeId: '$$st.subtypeId',
                slots: {
                  $filter: {
                    input: '$$st.slots',
                    as: 'sl',
                    cond: { $in: ['$$sl._id', slotOids] },
                  },
                },
              },
            },
          },
        },
      },
      { $unwind: '$subtypeSlots' },
      { $unwind: '$subtypeSlots.slots' },
      {
        $project: {
          plantId: 1,
          year: 1,
          subtypeId: '$subtypeSlots.subtypeId',
          slotId: '$subtypeSlots.slots._id',
          startDay: '$subtypeSlots.slots.startDay',
          endDay: '$subtypeSlots.slots.endDay',
          totalBookedPlants: '$subtypeSlots.slots.totalBookedPlants',
          primarySowed: '$subtypeSlots.slots.primarySowed',
          totalPlants: '$subtypeSlots.slots.totalPlants',
          availablePlants: '$subtypeSlots.slots.availablePlants',
          progressIsArray: { $isArray: '$subtypeSlots.slots.sowingInProgress' },
        },
      },
    ]),
    isExcessiveSowing
      ? null
      : PlantCms.findById(request.plantId).select('sowingBuffer').lean(),
  ]);
  const sowingBuffer = plant?.sowingBuffer || 0;

  const rowBySlotId = new Map();
  for (const row of slotRows) {
    const key = String(row.slotId);
    if (!rowBySlotId.has(key)) rowBySlotId.set(key, row);
  }

  const slotGaps = [];
  let totalGap = 0;
  for (const slotOid of slotOids) {
    const row = rowBySlotId.get(String(slotOid));
    if (!row) {
      console.error(`[IssueStock] Slot ${slotOid} not found in PlantSlot documents; skipping sowingInProgress entry.`);
      continue;
    }
    const gap = isExcessiveSowing
      ? 1
      : Math.ceil(((row.totalBookedPlants || 0) - (row.primarySowed || 0)) * (1 + sowingBuffer / 100));
    slotGaps.push({ row, gap });
    if (!isExcessiveSowing) totalGap += gap;
  }

  let remainingPackets = packetsForSlots;
  let remainingPlants = packetsForSlots * plantsPerPacket;
  const now = new Date();
  const ops = [];
  const trailRows = [];
  const resetLegacySlots = new Set();
  const touchedPlantSlots = new Set();
  const trailEntryBase = {
    action: 'STOCK_REQUEST_ISSUED',
    activityName: getSlotTrailActivityName('STOCK_REQUEST_ISSUED'),
    sowingRequestId: request._id,
    performedBy: userId,
    notes: `Outward: ${outward?.outwardNumber || 'N/A'}`,
    createdAt: now,
    updatedAt: now,
  };

  slotGaps.forEach(({ row, gap }, i) => {
    const isLastSlot = i === slotGaps.length - 1;
    let slotPackets;
    let slotPlants;

    if (isExcessiveSowing) {
      slotPackets = packetsForSlots;
      slotPlants = packetsForSlots * plantsPerPacket;
    } else if (isLastSlot) {
      slotPackets = remainingPackets;
      slotPlants = remainingPlants;
    } else {
      const proportion = totalGap > 0 ? gap / totalGap : 1 / slotGaps.length;
      slotPackets = packetsForSlots * proportion;
      slotPlants = gap;
      if (slotPackets > 0 && (!slotPlants || slotPlants <= 0)) {
        slotPlants = slotPackets * plantsPerPacket;
      }
      remainingPackets -= slotPackets;
      remainingPlants -= slotPlants;
    }

    slotPackets = Math.round(slotPackets * 100) / 100;
    if (!isExcessiveSowing && slotPackets > 0 && (!slotPlants || slotPlants <= 0)) {
      slotPlants = Math.round(slotPackets * plantsPerPacket * 100) / 100;
    }

    const impliedPlantsFromPackets =
      slotPackets > 0 ? Math.round(slotPackets * plantsPerPacket * 100) / 100 : 0;
    const entry = {
      _id: new mongoose.Types.ObjectId(),
      requestNumber: request.requestNumber,
      packetsIssued: slotPackets,
      plantsExpected: slotPlants > 0 ? slotPlants : impliedPlantsFromPackets,
      sowingRequestId: request._id,
      isExcessiveSowing,
      issuedDate: now,
    };
    if (outward?._id) entry.outwardId = outward._id;

    const slotKey = String(row.slotId);
    const progressPath = 'subtypeSlots.$[st].slots.$[sl].sowingInProgress';
    const needsReset = !row.progressIsArray && !resetLegacySlots.has(slotKey);
    if (needsReset) resetLegacySlots.add(slotKey);
    ops.push({
      updateOne: {
        filter: { _id: row._id },
        update: needsReset
          ? { $set: { [progressPath]: [entry] } }
          : { $push: { [progressPath]: entry } },
        arrayFilters: [{ 'st.slots._id': row.slotId }, { 'sl._id': row.slotId }],
      },
    });
    touchedPlantSlots.add(String(row._id));

    trailRows.push({
      plantSlotId: row._id,
      plantId: row.plantId,
      year: row.year,
      subtypeId: row.subtypeId,
      slotId: row.slotId,
      startDay: row.startDay,
      endDay: row.endDay,
      action: 'STOCK_REQUEST_ISSUED',
      createdAt: now,
      entry: {
        ...trailEntryBase,
        quantity: slotPackets,
        previousTotalPlants: row.totalPlants || 0,
        newTotalPlants: row.totalPlants || 0,
        previousAvailablePlants: row.availablePlants || 0,
        newAvailablePlants: row.availablePlants || 0,
        reason: `Stock issued for ${request.requestNumber}: ${slotPackets} packets (${slotPlants} plants expected) - Part of ${slotOids.length} slot request`,
      },
    });
  });

  if (!ops.length) return slotLinkage;

  try {
    await Promise.all([
      PlantSlot.collection.bulkWrite(ops, { ordered: true }),
      insertTrailRows(trailRows).catch((err) =>
        console.error('[IssueStock] Slot trail insert failed:', err?.message || err)
      ),
    ]);
    slotLinkage.slotsWritten = ops.length;
    slotLinkage.plantSlotDocsSaved = touchedPlantSlots.size;
  } catch (err) {
    console.error('[IssueStock] Error writing slot sowingInProgress:', err);
  }

  return slotLinkage;
};

// Issue stock from sowing request (exact quantity validation)
export const issueStockFromRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      batchAllocations: rawAllocations,
      notes,
      purpose = 'production',
      inventorySource,
      packetsFromBiotech: bodyPacketsBio,
      packetsFromRamAgri: bodyPacketsAgri,
      ramAgriBatchAllocations: rawAgriAllocations,
      expiryOrder,
    } = req.body;
    const batchAllocations = Array.isArray(rawAllocations) ? rawAllocations : [];
    const ramAgriBatchAllocations = Array.isArray(rawAgriAllocations)
      ? rawAgriAllocations
      : [];
    const issueExpiryOrder = expiryOrder === 'latest' ? 'latest' : 'fifo';

    if (purpose !== 'production') {
      return res.status(400).json({
        success: false,
        message: 'Sowing stock issue must use purpose "production" only.',
      });
    }

    const request = await SowingRequest.findById(id)
      .populate('primaryUnit', 'name symbol')
      .populate('secondaryUnit', 'name symbol');
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
    let issueSplit = {
      source: 'BIOTECH',
      packetsFromBiotech: companyIssueQty,
      packetsFromRamAgri: 0,
    };

    if (companyIssueQty < 0.01) {
      if (batchAllocations.length > 0 || ramAgriBatchAllocations.length > 0) {
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
    try {
      const { resolveIssueInventorySplit } = await import(
        '../services/sowingIssueInventory.service.js'
      );
      issueSplit = resolveIssueInventorySplit({
        companyIssueQty,
        inventorySource,
        packetsFromBiotech: bodyPacketsBio,
        packetsFromRamAgri: bodyPacketsAgri,
      });
    } catch (splitErr) {
      return res.status(400).json({
        success: false,
        message: splitErr.message || 'Invalid inventory source split',
      });
    }

    const needBiotech = issueSplit.packetsFromBiotech > 0.01;
    const needAgri = issueSplit.packetsFromRamAgri > 0.01;

    if (needBiotech && batchAllocations.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Batch allocations are required for Biotech warehouse packets',
      });
    }
    if (!needBiotech && batchAllocations.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Do not send Biotech batch allocations when issuing from Ram Agri Input only',
      });
    }

    // Validate Biotech batch allocations against Biotech packet qty only
    const primaryUnitId = request.primaryUnit?._id?.toString();
    const secondaryUnitId = request.secondaryUnit?._id?.toString();
    let allocationBatches = [];

    if (needBiotech) {
    const { RAM_AGRI_MIRROR_NOTE_REGEX } = await import(
      '../services/ramAgriLinkedProductSync.service.js'
    );
    const { resolveBiotechIssueProductIds } = await import(
      '../services/sowingIssueInventory.service.js'
    );
    const allowedProductIds = new Set(
      (
        await resolveBiotechIssueProductIds(
          request.plantId,
          request.subtypeId,
          request.productId
        )
      ).map(String)
    );
    allocationBatches = await Promise.all(
      batchAllocations.map((allocation) =>
        Batch.findById(allocation.batchId)
          .populate('unit', 'name symbol _id')
          .populate('product', 'name')
          .lean()
      )
    );
    for (const [allocationIndex, allocation] of batchAllocations.entries()) {
      const batch = allocationBatches[allocationIndex];

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

      if (RAM_AGRI_MIRROR_NOTE_REGEX.test(String(batch.notes || ''))) {
        return res.status(400).json({
          success: false,
          message: `Batch ${batch.batchNumber} is Ram Agri Input stock — issue it from the Ram Agri Input source, not Biotech warehouse.`,
        });
      }

      const batchProductId = String(batch.product?._id || batch.product || '');
      if (allowedProductIds.size && batchProductId && !allowedProductIds.has(batchProductId)) {
        return res.status(400).json({
          success: false,
          message: `Batch ${batch.batchNumber} is not linked to ${request.plantName} ${request.subtypeName}.`,
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

      if (batch.remainingQuantity < allocation.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient quantity in batch ${batch.batchNumber}. Available: ${batch.remainingQuantity}, Required: ${allocation.quantity}`,
        });
      }
    }

    if (Math.abs(totalAllocated - issueSplit.packetsFromBiotech) > 0.01) {
      return res.status(400).json({
        success: false,
        message: `Biotech allocated (${totalAllocated.toFixed(2)}) must match Biotech packets (${issueSplit.packetsFromBiotech}). Company total is ${companyIssueQty}; Ram Agri share is ${issueSplit.packetsFromRamAgri}.`,
      });
    }
    } else {
      totalAllocated = 0;
    }

    // Calculate excess packets vs needed company portion
    const companyNeeded =
      request.packetsFromCompany != null && Number.isFinite(Number(request.packetsFromCompany))
        ? Number(request.packetsFromCompany)
        : Math.max(0, Number(request.packetsNeeded) || 0);
    excessPackets = Math.max(0, companyIssueQty - companyNeeded);

    // Ram Agri packets: create internal PO (Ram Agri → Biotech), then issue from transferred batch.
    let agriAllocations = [];
    const transferBatchAllocations = [];
    if (needAgri) {
      const transferProduct = await Product.findById(request.productId);
      if (!transferProduct) {
        return res.status(404).json({
          success: false,
          message: 'Product not found',
        });
      }
      try {
        const { maybeCreateSowingTransferPurchaseOrder } = await import(
          '../services/sowingRamAgriTransfer.service.js'
        );
        const transferResult = await maybeCreateSowingTransferPurchaseOrder({
          product: transferProduct,
          companyPackets: issueSplit.packetsFromRamAgri,
          sowingRequest: request,
          userId: req.user._id,
          forceQty: true,
          ramAgriBatchAllocations,
          expiryOrder: issueExpiryOrder,
        });
        if (!transferResult || transferResult.skipped) {
          return res.status(400).json({
            success: false,
            message:
              transferResult?.reason ||
              'Cannot create internal PO. Link this packing to a Ram Agri seed variety first.',
          });
        }
        request.transferPurchaseOrderId = transferResult.purchaseOrder?._id;
        request.transferShortfallQty = transferResult.shortfall || issueSplit.packetsFromRamAgri;
        agriAllocations = (transferResult.agriAllocations || []).map((a) => ({
          batchId: a.batchId,
          batchNumber: a.batchNumber,
          quantityDeducted: a.quantityDeducted,
          ramAgriCropId: a.ramAgriCropId,
          ramAgriVarietyId: a.ramAgriVarietyId,
        }));
        const tb = transferResult.batch;
        if (!tb?._id) {
          return res.status(400).json({
            success: false,
            message: 'Internal PO created but no Biotech batch was inwarded',
          });
        }
        transferBatchAllocations.push({
          batchId: tb._id,
          batchNumber: tb.batchNumber,
          quantity: issueSplit.packetsFromRamAgri,
        });
      } catch (transferErr) {
        return res.status(400).json({
          success: false,
          message: transferErr.message || 'Failed to create internal transfer PO',
        });
      }
    }

    const outwardAllocations = [...batchAllocations, ...transferBatchAllocations];
    const shouldCreateOutward = outwardAllocations.length > 0;

    if (shouldCreateOutward) {
    // Create outward entry and issue stock directly
    const outwardNumber = await InventoryOutward.generateOutwardNumber();
    const outwardItems = outwardAllocations.map((allocation) => {
      const fromBio = allocationBatches.find(
        (row) => String(row?._id) === String(allocation.batchId)
      );
      const item = {
        product: fromBio?.product?._id || fromBio?.product || request.productId,
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
      purposeDetails: `Sowing request: ${request.requestNumber} - ${request.plantName} ${request.subtypeName}${excessPackets > 0 ? ` (Excess: ${excessPackets.toFixed(2)} packets)` : ''} [${issueSplit.source}]`,
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

    // Issue stock directly (deduct from the batch's own product, not only request.productId)
    const productById = new Map();
    const loadIssueProduct = async (productId) => {
      const key = String(productId || '');
      if (!key) throw new Error('Product not found');
      if (productById.has(key)) return productById.get(key);
      const found = await Product.findById(productId);
      if (!found) throw new Error('Product not found');
      productById.set(key, found);
      return found;
    };

    const createOutwardTransaction = async (item, outwardDoc, user, stockProduct) => {
      const transactionNumber = await InventoryTransaction.generateTransactionNumber();
      const transaction = new InventoryTransaction({
        transactionNumber,
        transactionType: 'outward',
        product: item.product,
        batch: item.batch,
        quantity: item.quantity,
        unit: item.unit,
        balanceBeforeTransaction: stockProduct.currentStock,
        balanceAfterTransaction: stockProduct.currentStock - item.quantity,
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

    // Update batches and product stock (no Ram Agri mirror — pool is explicit)
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

      const stockProduct = await loadIssueProduct(item.product || batch.product);
      if (stockProduct.currentStock < item.quantity) {
        throw new Error(
          `Insufficient stock in ${stockProduct.name}. Available: ${stockProduct.currentStock}, Required: ${item.quantity}`
        );
      }

      await createOutwardTransaction(item, outward, req.user, stockProduct);

      // Update batch
      batch.remainingQuantity -= item.quantity;
      if (batch.remainingQuantity <= 0) {
        batch.status = 'exhausted';
      }
      await batch.save();

      stockProduct.currentStock -= item.quantity;
      if (stockProduct.currentStock > 0 && stockProduct.stockValue > 0) {
        stockProduct.averagePrice = stockProduct.stockValue / stockProduct.currentStock;
      } else {
        stockProduct.averagePrice = 0;
      }
      stockProduct.updatedBy = req.user._id;
      await stockProduct.save();
    }

    // Update outward status to issued
    outward.status = 'issued';
    outward.issuedBy = req.user._id;
    outward.issuedDate = new Date();
    outward.updatedBy = req.user._id;
    await outward.save();
    } // end shouldCreateOutward

    // Update request status and excess packets
    request.status = 'issued';
    request.issuedBy = req.user._id;
    request.issuedDate = new Date();
    if (outward?._id) request.outwardId = outward._id;
    request.packetsIssued = companyIssueQty;
    request.packetsIssuedFromBiotech = issueSplit.packetsFromBiotech;
    request.packetsIssuedFromRamAgri = issueSplit.packetsFromRamAgri;
    request.issueInventorySource = issueSplit.source;
    request.biotechBatchAllocations = shouldCreateOutward
      ? outwardAllocations.map((a) => {
          const fromBio = allocationBatches.find(
            (row) => String(row?._id) === String(a.batchId)
          );
          return {
            batchId: a.batchId,
            batchNumber: a.batchNumber || fromBio?.batchNumber,
            quantity: a.quantity,
            productId: fromBio?.product?._id || fromBio?.product || request.productId,
          };
        })
      : [];
    request.ramAgriBatchAllocations = agriAllocations;
    request.excessPackets = excessPackets;
    request.sowingInProgress = true; // Mark sowing as in progress when stock is issued
    if (!request.sowingStartedDate) {
      request.sowingStartedDate = new Date(); // Set start date if not already set
    }
    await request.save();
    } // end companyIssueQty > 0

    // Packets for slot sowingInProgress: full request (company + raising) when available
    const packetsForSlots = Math.max(companyIssueQty, packetsRequested) || packetsRequested;

    const slotLinkage = await linkIssuedRequestToSlots({
      request,
      outward,
      packetsForSlots,
      userId: req.user._id,
    });

    await request.populate(['primaryUnit', 'secondaryUnit', 'productId', 'issuedBy', 'outwardId']);

    bustSowingCardsLiteCache();

    res.json({
      success: true,
      message:
        companyIssueQty < 0.01
          ? 'Raising-only request marked issued (no warehouse stock)'
          : request.transferPurchaseOrderId
            ? 'Stock issued successfully. Internal PO created for Ram Agri packets.'
            : 'Stock issued successfully from sowing request',
      data: {
        request,
        outward,
        transferPurchaseOrderId: request.transferPurchaseOrderId || null,
        transferShortfallQty: request.transferShortfallQty || 0,
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

    bustSowingCardsLiteCache();

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
      const raisingRestore =
        await restoreCancelledRequestRaisingPackets(request);
      request.status = 'cancelled';
      request.cancelledBy = req.user?._id;
      request.cancelledDate = new Date();
      request.cancellationReason = reason || 'Request cancelled before stock issuance';
      await request.save();

      bustSowingCardsLiteCache();

      return res.json({
        success: true,
        message: 'Sowing request cancelled successfully (no stock was issued)',
        data: request,
        raisingRestore,
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
    const raisingRestore =
      await restoreCancelledRequestRaisingPackets(request);
    request.status = 'cancelled';
    request.sowingInProgress = false;
    request.cancelledBy = req.user?._id;
    request.cancelledDate = new Date();
    request.cancellationReason = reason || 'Sowing request cancelled';
    await request.save();

    console.log(`✅ Successfully cancelled sowing request ${request.requestNumber}`);

    bustSowingCardsLiteCache();

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
          raisingPacketsReturned: raisingRestore.restored,
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

    bustSowingCardsLiteCache();

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
