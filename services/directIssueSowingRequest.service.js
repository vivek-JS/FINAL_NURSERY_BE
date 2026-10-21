import Product from "../models/product.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import {
  buildIssueInventoryAvailability,
  loadBiotechIssueBatches,
  packetsInRequestUnit,
} from "./sowingIssueInventory.service.js";
import { resolveRamAgriForSeedProduct } from "./ramAgriVarietyInventoryLink.service.js";

const companyPacketsOf = (request) => {
  if (
    request?.packetsFromCompany != null &&
    Number.isFinite(Number(request.packetsFromCompany))
  ) {
    return Math.max(0, Number(request.packetsFromCompany));
  }
  if (request?.seedSource === "RAISING") return 0;
  return Math.max(0, Number(request?.packetsRequested || request?.packetsNeeded) || 0);
};

const idOf = (value) => value?._id || value;

/** Packets → quantity stored on the batch (secondary unit uses the conversion factor). */
function quantityInBatchUnit(batch, request, takePackets) {
  if (!request) return takePackets;
  const batchUnitId = batch?.unit?._id?.toString() || batch?.unit?.toString();
  const secondaryUnitId =
    request?.secondaryUnit?._id?.toString() || request?.secondaryUnit?.toString();
  const cf = Number(request?.conversionFactor) || 0;
  if (batchUnitId && secondaryUnitId && batchUnitId === secondaryUnitId && cf > 0) {
    return takePackets * cf;
  }
  return takePackets;
}

/**
 * Fill packet qty from batches soonest-expiry first.
 * Pass request so Biotech batch units convert to packets. Omit it for Ram Agri lots (already packets).
 */
export function allocateFifoPackets(batches, packetsNeeded, request = null) {
  const needed = Math.max(0, Number(packetsNeeded) || 0);
  const ranked = [...(batches || [])].sort((a, b) => {
    const ae = a?.expiryDate ? new Date(a.expiryDate).getTime() : Number.POSITIVE_INFINITY;
    const be = b?.expiryDate ? new Date(b.expiryDate).getTime() : Number.POSITIVE_INFINITY;
    if (ae !== be) return ae - be;
    const ar = a?.receivedDate ? new Date(a.receivedDate).getTime() : 0;
    const br = b?.receivedDate ? new Date(b.receivedDate).getTime() : 0;
    return ar - br;
  });

  const allocations = [];
  let remaining = needed;
  for (const batch of ranked) {
    if (remaining <= 0.01) break;
    const availablePackets = request
      ? packetsInRequestUnit(batch, request)
      : Math.max(0, Number(batch?.remainingQuantity) || 0);
    if (availablePackets <= 0.01) continue;
    const takePackets = Math.min(remaining, availablePackets);
    allocations.push({
      batchId: batch._id,
      quantity: Number(quantityInBatchUnit(batch, request, takePackets).toFixed(2)),
      expiryDate: batch.expiryDate || undefined,
      ramAgriCropId: idOf(batch.ramAgriCropId),
      ramAgriVarietyId: idOf(batch.ramAgriVarietyId),
    });
    remaining -= takePackets;
  }
  return { allocations, shortfall: Math.max(0, remaining) };
}

const shortStockMessage = (packets) =>
  `Not enough stock on this packing to issue ${Number(packets).toFixed(2)} packets.`;

/** Body for the existing issue endpoint: one product, FIFO batches, preferred warehouse. */
export async function buildDirectIssueBody(request) {
  const companyQty = companyPacketsOf(request);
  const note = `Direct sowing request ${request.requestNumber}`;
  if (companyQty < 0.01) {
    return {
      ok: true,
      body: {
        batchAllocations: [],
        purpose: "production",
        notes: note,
      },
    };
  }

  const productId = idOf(request.productId);
  const plantId = idOf(request.plantId);
  const subtypeId = idOf(request.subtypeId);
  const product = request.productId?.name
    ? request.productId
    : await Product.findById(productId).lean();
  const avail = await buildIssueInventoryAvailability(plantId, subtypeId, productId);

  if (avail.preferredSource === "RAM_AGRI") {
    const match = await resolveRamAgriForSeedProduct(product);
    const cropId = String(idOf(match?.cropId) || "");
    const varietyId = String(idOf(match?.varietyId) || "");
    const batches = (avail.ramAgriBatches || []).filter((batch) => {
      const crop = String(idOf(batch.ramAgriCropId) || "");
      const variety = String(idOf(batch.ramAgriVarietyId) || "");
      return crop === cropId && variety === varietyId;
    });
    const { allocations, shortfall } = allocateFifoPackets(batches, companyQty, null);
    if (shortfall > 0.01 || !allocations.length) {
      return { ok: false, message: shortStockMessage(companyQty) };
    }
    return {
      ok: true,
      body: {
        purpose: "production",
        inventorySource: "RAM_AGRI",
        packetsFromBiotech: 0,
        packetsFromRamAgri: companyQty,
        batchAllocations: [],
        ramAgriBatchAllocations: allocations.map((row) => ({
          batchId: row.batchId,
          quantity: row.quantity,
          ramAgriCropId: row.ramAgriCropId,
          ramAgriVarietyId: row.ramAgriVarietyId,
        })),
        expiryOrder: "fifo",
        notes: note,
      },
    };
  }

  const loaded = await loadBiotechIssueBatches({
    plantId,
    subtypeId,
    fallbackProductId: productId,
  });
  const batches = loaded.filter(
    (batch) => String(idOf(batch.product)) === String(productId)
  );
  const { allocations, shortfall } = allocateFifoPackets(batches, companyQty, request);
  if (shortfall > 0.01 || !allocations.length) {
    return { ok: false, message: shortStockMessage(companyQty) };
  }
  return {
    ok: true,
    body: {
      purpose: "production",
      inventorySource: "BIOTECH",
      packetsFromBiotech: companyQty,
      packetsFromRamAgri: 0,
      batchAllocations: allocations.map((row) => ({
        batchId: row.batchId,
        quantity: row.quantity,
        expiryDate: row.expiryDate,
      })),
      ramAgriBatchAllocations: [],
      expiryOrder: "fifo",
      notes: note,
    },
  };
}

/** Mark issued + sowing in progress without warehouse / linked-stock movement. */
export async function markIssuedWithoutStock(request, user) {
  const fresh = await SowingRequest.findById(request?._id || request);
  if (!fresh) return request;
  if (fresh.status === "issued") {
    fresh.sowingInProgress = true;
    if (!fresh.sowingStartedDate) fresh.sowingStartedDate = new Date();
    await fresh.save();
    return fresh;
  }
  fresh.status = "issued";
  fresh.issuedBy = user?._id;
  fresh.issuedDate = new Date();
  fresh.packetsIssued = Number(fresh.packetsFromCompany) || 0;
  fresh.sowingInProgress = true;
  if (!fresh.sowingStartedDate) fresh.sowingStartedDate = new Date();
  fresh.notes = [fresh.notes, "Issued without warehouse stock — sowing in progress"]
    .filter(Boolean)
    .join(" · ");
  await fresh.save();
  return fresh;
}

/** Drop a still-pending direct request so Inventory never has to accept it. */
export async function abandonUnissuedRequest(requestId, user, reason) {
  const fresh = await SowingRequest.findById(requestId);
  if (!fresh || fresh.status !== "pending" || fresh.outwardId) return fresh;

  const packets = Math.max(0, Number(fresh.packetsFromRaising) || 0);
  const intakeIds = fresh.raisingIntakeIds || [];
  if (packets > 0 && intakeIds.length) {
    const { restoreRaisingPackets } = await import("../controllers/raisingSeed.controller.js");
    await restoreRaisingPackets({ intakeIds, packetsToRestore: packets });
  }

  fresh.status = "cancelled";
  fresh.cancelledBy = user?._id;
  fresh.cancelledDate = new Date();
  fresh.cancellationReason = reason || "Direct sowing request could not be issued";
  await fresh.save();
  return fresh;
}
