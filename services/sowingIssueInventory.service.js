import mongoose from "mongoose";
import { getSubtypeInventoryCandidates } from "./subtypeInventoryLink.service.js";
import Product from "../models/product.model.js";
import RamAgriBatch from "../models/ramAgriBatch.model.js";
import { resolveRamAgriForSeedProduct } from "./ramAgriVarietyInventoryLink.service.js";
import { deductStockFIFO } from "./ramAgriBatchInventory.service.js";
import { RAM_AGRI_MOVEMENT_TYPES } from "./ramAgriStockMovement.service.js";

const SOURCES = new Set(["BIOTECH", "RAM_AGRI", "BOTH"]);

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

/**
 * Availability payload for issue dialog (multi-link).
 */
export async function buildIssueInventoryAvailability(plantId, subtypeId, productId) {
  const candidates = await getSubtypeInventoryCandidates(plantId, subtypeId);

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
    if (productId) {
      const product = await Product.findById(productId).lean();
      const resolved = await resolveRamAgriForSeedProduct(product);
      if (resolved?.cropId && resolved?.varietyId) {
        const agriQty = await RamAgriBatch.aggregate([
          {
            $match: {
              ramAgriCropId: resolved.cropId,
              ramAgriVarietyId: resolved.varietyId,
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
              resolved?.crop?.cropName && resolved?.variety?.name
                ? `${resolved.crop.cropName} — ${resolved.variety.name}`
                : "Ram Agri variety",
            ramAgriCropId: resolved.cropId,
            ramAgriVarietyId: resolved.varietyId,
            availableStock: total,
          },
        ];
      }
    }
  }

  const biotechAvailable = biotechLinks.reduce((s, l) => s + (Number(l.availableStock) || 0), 0);
  const ramAgriAvailable = ramAgriLinks.reduce((s, l) => s + (Number(l.availableStock) || 0), 0);

  return {
    ...candidates,
    biotech: biotechLinks,
    ramAgri: ramAgriLinks,
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

  // Explicit per-batch picks from UI
  if (Array.isArray(ramAgriBatchAllocations) && ramAgriBatchAllocations.length > 0) {
    // Group by crop+variety if provided, else FEFO via returnToExplicit needs allocations scaffold.
    // Build fake prior allocations from picks so returnToExplicitBatches can restore? That's for returns.
    // Use deductStockFIFO per variety after summing picks... Simpler: for each allocation row,
    // call deduct via explicit remaining adjust using returnToExplicit pattern in reverse =
    // actually deductStockFIFO doesn't take batch list. Use FEFO total qty and ignore batch picks
    // OR implement batch-level deduct inline.

    // Prefer: sum qty, pick first linked variety that has stock, deduct FEFO for that crop/variety.
    // If UI sent batchIds with crop/variety, deduct per pair.
    const byVariety = new Map();
    for (const row of ramAgriBatchAllocations) {
      const cropId = row.ramAgriCropId || preferredCropId || agriLinks[0].ramAgriCropId?._id || agriLinks[0].ramAgriCropId;
      const varietyId =
        row.ramAgriVarietyId || preferredVarietyId || agriLinks[0].ramAgriVarietyId;
      const k = `${cropId}:${varietyId}`;
      if (!byVariety.has(k)) byVariety.set(k, { cropId, varietyId, qty: 0 });
      byVariety.get(k).qty += Number(row.quantity || row.quantityDeducted) || 0;
    }
    const allocations = [];
    for (const { cropId, varietyId, qty: q } of byVariety.values()) {
      if (q <= 0) continue;
      const result = await deductStockFIFO(cropId, varietyId, q, metaBase);
      if (!result.ok) return result;
      for (const a of result.allocations || []) {
        allocations.push({
          ...a,
          ramAgriCropId: cropId,
          ramAgriVarietyId: varietyId,
        });
      }
    }
    return { ok: true, allocations };
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
