import mongoose from "mongoose";
import { getSubtypeInventoryCandidates } from "./subtypeInventoryLink.service.js";
import Product from "../models/product.model.js";
import Batch from "../models/batch.model.js";
import RamAgriBatch from "../models/ramAgriBatch.model.js";
import { RAM_AGRI_MIRROR_NOTE_REGEX } from "./ramAgriLinkedProductSync.service.js";
import { resolveRamAgriForSeedProduct } from "./ramAgriVarietyInventoryLink.service.js";
import { deductStockFIFO, deductStockFromBatches } from "./ramAgriBatchInventory.service.js";
import { RAM_AGRI_MOVEMENT_TYPES } from "./ramAgriStockMovement.service.js";

const SOURCES = new Set(["BIOTECH", "RAM_AGRI", "BOTH"]);

/**
 * Prefer Ram Agri only when this exact product originates from a linked
 * Ram Agri Input variety. A plant/subtype fallback must not flip Biotech
 * warehouse products to Ram Agri.
 */
export function resolvePreferredIssueSource(ramAgriMatch) {
  if (
    ramAgriMatch?.cropId &&
    ramAgriMatch?.varietyId &&
    ramAgriMatch.matchedBy !== "plantSubtype"
  ) {
    return "RAM_AGRI";
  }
  return "BIOTECH";
}

/**
 * Normalize office inventory-pool choice for sowing issue.
 * @returns {{ source, packetsFromBiotech, packetsFromRamAgri }}
 */
export function resolveIssueInventorySplit({
  companyIssueQty,
  inventorySource,
  packetsFromBiotech,
  packetsFromRamAgri,
}) {
  const company = Number(companyIssueQty) || 0;
  let source = String(inventorySource || "BIOTECH").toUpperCase().trim();
  if (!SOURCES.has(source)) {
    throw new Error('inventorySource must be BIOTECH, RAM_AGRI, or BOTH');
  }

  let fromBio = Number(packetsFromBiotech);
  let fromAgri = Number(packetsFromRamAgri);

  if (source === "BIOTECH") {
    fromBio = Number.isFinite(fromBio) && fromBio >= 0 ? fromBio : company;
    fromAgri = 0;
    if (Math.abs(fromBio - company) > 0.01) {
      throw new Error(
        `Biotech packets (${fromBio}) must equal company packets to issue (${company})`
      );
    }
  } else if (source === "RAM_AGRI") {
    fromAgri = Number.isFinite(fromAgri) && fromAgri >= 0 ? fromAgri : company;
    fromBio = 0;
    if (Math.abs(fromAgri - company) > 0.01) {
      throw new Error(
        `Ram Agri packets (${fromAgri}) must equal company packets to issue (${company})`
      );
    }
  } else {
    // BOTH — office must enter both counts
    if (!Number.isFinite(fromBio) || fromBio <= 0 || !Number.isFinite(fromAgri) || fromAgri <= 0) {
      throw new Error(
        "For Both, enter packets from Biotech and from Ram Agri Input (both must be > 0)"
      );
    }
    if (Math.abs(fromBio + fromAgri - company) > 0.01) {
      throw new Error(
        `Biotech (${fromBio}) + Ram Agri (${fromAgri}) must equal company packets (${company})`
      );
    }
  }

  return {
    source,
    packetsFromBiotech: fromBio,
    packetsFromRamAgri: fromAgri,
  };
}

/** Unique Biotech product ObjectIds from subtype links + the request product. */
export function collectBiotechProductIds(biotechLinks = [], fallbackProductId) {
  const ids = [];
  const seen = new Set();
  const add = (raw) => {
    const id = raw?._id || raw;
    if (!id || !mongoose.isValidObjectId(id)) return;
    const key = String(id);
    if (seen.has(key)) return;
    seen.add(key);
    ids.push(new mongoose.Types.ObjectId(key));
  };
  for (const link of biotechLinks || []) add(link?.productId);
  add(fallbackProductId);
  return ids;
}

export function packetsInRequestUnit(batch, request) {
  const qty = Number(batch?.remainingQuantity) || 0;
  const batchUnitId = batch?.unit?._id?.toString();
  const primaryUnitId =
    request?.primaryUnit?._id?.toString() || request?.primaryUnit?.toString();
  const secondaryUnitId =
    request?.secondaryUnit?._id?.toString() || request?.secondaryUnit?.toString();
  if (
    batchUnitId &&
    secondaryUnitId &&
    batchUnitId === secondaryUnitId &&
    Number(request?.conversionFactor) > 0
  ) {
    return qty / Number(request.conversionFactor);
  }
  return qty;
}

/** Biotech products that the issue dialog can actually take stock from. */
export async function resolveBiotechIssueProductIds(
  plantId,
  subtypeId,
  fallbackProductId
) {
  const candidates = await getSubtypeInventoryCandidates(plantId, subtypeId);
  let links = candidates.biotech || [];
  if (!links.length && plantId && subtypeId) {
    const products = await Product.find({ plantId, subtypeId }).select("_id").lean();
    links = (products || []).map((p) => ({ productId: p._id }));
  }
  return collectBiotechProductIds(links, fallbackProductId);
}

/** Issuable Biotech warehouse batches across every product linked to this subtype. */
export async function loadBiotechIssueBatches({
  plantId,
  subtypeId,
  fallbackProductId,
} = {}) {
  const productIds = await resolveBiotechIssueProductIds(
    plantId,
    subtypeId,
    fallbackProductId
  );
  if (!productIds.length) return [];
  return Batch.find({
    product: { $in: productIds },
    status: { $in: ["active", "expired"] },
    remainingQuantity: { $gt: 0 },
    notes: { $not: RAM_AGRI_MIRROR_NOTE_REGEX },
  })
    .select(
      "batchNumber product receivedDate supplier purchasePrice quantity remainingQuantity unit status grn expiryDate manufactureDate notes"
    )
    .populate("unit", "name symbol")
    .populate("supplier", "name")
    .populate("product", "name code currentStock")
    .sort({ expiryDate: 1, receivedDate: 1 })
    .lean();
}

/**
 * Biotech products linked to a Ram Agri variety carry mirror batches of the
 * Ram Agri lots, and their currentStock includes them. Those packets are
 * already counted under Ram Agri, so drop them from Biotech availability.
 */
async function withoutRamAgriMirrorStock(biotechLinks) {
  const productIds = biotechLinks
    .map((l) => l.productId?._id || l.productId)
    .filter((id) => id && mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!productIds.length) return biotechLinks;

  const mirrored = await Batch.aggregate([
    {
      $match: {
        product: { $in: productIds },
        notes: RAM_AGRI_MIRROR_NOTE_REGEX,
        status: { $in: ["active", "expired"] },
        remainingQuantity: { $gt: 0 },
      },
    },
    { $group: { _id: "$product", total: { $sum: "$remainingQuantity" } } },
  ]);
  const mirrorByProduct = new Map(mirrored.map((m) => [String(m._id), Number(m.total) || 0]));

  return biotechLinks.map((link) => {
    const pid = String(link.productId?._id || link.productId || "");
    const mirror = mirrorByProduct.get(pid) || 0;
    if (!mirror) return link;
    return {
      ...link,
      availableStock: Math.max(0, (Number(link.availableStock) || 0) - mirror),
    };
  });
}

/**
 * Availability payload for issue dialog (multi-link).
 */
export async function buildIssueInventoryAvailability(plantId, subtypeId, productId) {
  const candidates = await getSubtypeInventoryCandidates(plantId, subtypeId);
  const exactProductId = productId?._id || productId;
  const exactProduct = exactProductId
    ? await Product.findById(exactProductId).lean()
    : null;
  const exactRamAgri = exactProduct
    ? await resolveRamAgriForSeedProduct(exactProduct)
    : null;
  const preferredSource = resolvePreferredIssueSource(exactRamAgri);

  let biotechLinks = candidates.biotech || [];
  let ramAgriLinks = candidates.ramAgri || [];

  // Fallback:
  // Some plant/subtype pairs may have no active SubtypeInventoryLink rows yet.
  // In that case, still compute availability from the underlying inventory sources.
  // This prevents the issue dialog from showing 0 stock when Agri/Biotech stock exists.
  if (biotechLinks.length === 0 && ramAgriLinks.length === 0) {
    // Biotech fallback from seed products stored against plant/subtype.
    // (Only applies if those legacy fields are present.)
    const biotechProducts = await Product.find({
      plantId: plantId,
      subtypeId: subtypeId,
    })
      .select("_id name currentStock")
      .lean();

    biotechLinks = (biotechProducts || []).map((p) => ({
      source: "BIOTECH",
      displayName: p?.name,
      productId: p?._id,
      availableStock: Number(p?.currentStock) || 0,
    }));

    // Ram Agri fallback: map seed product -> Ram Agri crop/variety using the inventory link
    // service, then compute availability from RamAgriBatch remainingQuantity.
    // NOTE: this dialog selection ultimately depends on seed variety, not solely plant/subtype.
    if (exactRamAgri?.cropId && exactRamAgri?.varietyId) {
        const agriQty = await RamAgriBatch.aggregate([
          {
            $match: {
              ramAgriCropId: exactRamAgri.cropId,
              ramAgriVarietyId: exactRamAgri.varietyId,
              status: "active",
              remainingQuantity: { $gt: 0 },
            },
          },
          { $group: { _id: null, total: { $sum: "$remainingQuantity" } } },
        ]);
        const total = Number(agriQty?.[0]?.total) || 0;
        ramAgriLinks = [
          {
            source: "RAM_AGRI",
            displayName:
              exactRamAgri?.crop?.cropName && exactRamAgri?.variety?.name
                ? `${exactRamAgri.crop.cropName} — ${exactRamAgri.variety.name}`
                : "Ram Agri variety",
            ramAgriCropId: exactRamAgri.cropId,
            ramAgriVarietyId: exactRamAgri.varietyId,
            availableStock: total,
          },
        ];
    }
  }

  biotechLinks = await withoutRamAgriMirrorStock(biotechLinks);

  const biotechAvailable = biotechLinks.reduce((s, l) => s + (Number(l.availableStock) || 0), 0);
  const ramAgriAvailable = ramAgriLinks.reduce((s, l) => s + (Number(l.availableStock) || 0), 0);
  const ramAgriBatchFilters = ramAgriLinks
    .map((link) => ({
      ramAgriCropId: link.ramAgriCropId?._id || link.ramAgriCropId,
      ramAgriVarietyId: link.ramAgriVarietyId?._id || link.ramAgriVarietyId,
    }))
    .filter((link) => link.ramAgriCropId && link.ramAgriVarietyId);
  const ramAgriBatches = ramAgriBatchFilters.length
    ? await RamAgriBatch.find({
        $or: ramAgriBatchFilters,
        status: { $in: ["active", "expired"] },
        remainingQuantity: { $gt: 0 },
      })
        .select(
          "batchNumber ramAgriCropId ramAgriVarietyId remainingQuantity expiryDate status"
        )
        .sort({ expiryDate: 1, receivedDate: 1 })
        .lean()
    : [];

  return {
    ...candidates,
    biotech: biotechLinks,
    ramAgri: ramAgriLinks,
    ramAgriBatches,
    preferredSource,
    totals: {
      biotechAvailable,
      ramAgriAvailable,
    },
  };
}

/**
 * Deduct Ram Agri packets for sowing issue (no classic Product mirror double-count).
 * Prefer explicit batchReturns; else FEFO across all linked varieties until qty filled.
 */
export async function deductRamAgriForSowingIssue({
  plantId,
  subtypeId,
  qtyPrimary,
  ramAgriBatchAllocations,
  preferredCropId,
  preferredVarietyId,
  userId,
  sowingRequestId,
  requestNumber,
}) {
  const qty = Number(qtyPrimary) || 0;
  if (qty <= 0) return { ok: true, restored: [], allocations: [] };

  const candidates = await getSubtypeInventoryCandidates(plantId, subtypeId);
  let agriLinks = candidates.ramAgri || [];

  if (preferredCropId && preferredVarietyId) {
    agriLinks = agriLinks.filter(
      (l) =>
        String(l.ramAgriCropId?._id || l.ramAgriCropId) === String(preferredCropId) &&
        String(l.ramAgriVarietyId) === String(preferredVarietyId)
    );
    if (!agriLinks.length) {
      agriLinks = [
        {
          ramAgriCropId: preferredCropId,
          ramAgriVarietyId: preferredVarietyId,
        },
      ];
    }
  }

  if (!agriLinks.length) {
    return {
      ok: false,
      error:
        "No Ram Agri Input variety linked to this plant/subtype. Add a link on Seed Dual Inventory Links first.",
    };
  }

  const metaBase = {
    userId,
    referenceType: "SowingRequest",
    referenceId: sowingRequestId,
    referenceNumber: requestNumber,
    description: `Sowing issue from Ram Agri Input (${requestNumber})`,
    movementType: RAM_AGRI_MOVEMENT_TYPES.SOWING_RAISING_OUT,
    metadata: { sowingIssue: true, inventorySource: "RAM_AGRI" },
  };

  // Explicit per-batch picks from UI (FIFO fill, latest-expiry fill, or manual edits)
  if (Array.isArray(ramAgriBatchAllocations) && ramAgriBatchAllocations.length > 0) {
    const picks = ramAgriBatchAllocations
      .map((row) => ({
        batchId: row.batchId || row._id,
        quantity: Number(row.quantity || row.quantityDeducted) || 0,
        ramAgriCropId: row.ramAgriCropId,
        ramAgriVarietyId: row.ramAgriVarietyId,
      }))
      .filter((row) => row.batchId && row.quantity > 0);
    if (picks.length > 0) {
      const result = await deductStockFromBatches(picks, {
        ...metaBase,
        cropId: preferredCropId,
        varietyId: preferredVarietyId,
      });
      if (!result.ok) return result;
      return { ok: true, allocations: result.allocations || [] };
    }
  }

  // FEFO across linked varieties until qty filled
  const sorted = [...agriLinks].sort(
    (a, b) => (Number(b.availableStock) || 0) - (Number(a.availableStock) || 0)
  );
  let remaining = qty;
  const allocations = [];
  for (const link of sorted) {
    if (remaining <= 0.01) break;
    const cropId = link.ramAgriCropId?._id || link.ramAgriCropId;
    const varietyId = link.ramAgriVarietyId;
    if (!cropId || !varietyId) continue;
    const result = await deductStockFIFO(cropId, varietyId, remaining, metaBase);
    if (result.ok) {
      for (const a of result.allocations || []) {
        allocations.push({
          ...a,
          ramAgriCropId: cropId,
          ramAgriVarietyId: varietyId,
        });
        remaining -= Number(a.quantityDeducted) || 0;
      }
      remaining = Math.max(0, remaining);
      continue;
    }
    // Insufficient on this variety — try next if partial unavailable
    const avail = Number(link.availableStock) || 0;
    if (avail > 0.01) {
      const take = Math.min(remaining, avail);
      const partial = await deductStockFIFO(cropId, varietyId, take, metaBase);
      if (!partial.ok) continue;
      for (const a of partial.allocations || []) {
        allocations.push({
          ...a,
          ramAgriCropId: cropId,
          ramAgriVarietyId: varietyId,
        });
        remaining -= Number(a.quantityDeducted) || 0;
      }
    }
  }

  if (remaining > 0.01) {
    return {
      ok: false,
      error: `Insufficient Ram Agri stock. Still need ${remaining} packets.`,
      allocations,
    };
  }

  return { ok: true, allocations };
}

export function isValidObjectId(id) {
  return mongoose.isValidObjectId(id);
}
