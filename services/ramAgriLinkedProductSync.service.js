/**
 * Keep inventory Product + classic Batch in sync with Ram Agri variety stock
 * so sowing (Product + Batch) can issue company seed from Ram Agri lots.
 */
import mongoose from "mongoose";
import RamAgriBatch from "../models/ramAgriBatch.model.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";
import Product from "../models/product.model.js";
import Batch from "../models/batch.model.js";

const LINK_NOTE_PREFIX = "linkedRamAgriBatchId:";

/** Classic Batch rows that only mirror a Ram Agri lot (not real Biotech warehouse stock). */
export const RAM_AGRI_MIRROR_NOTE_REGEX = new RegExp(`^${LINK_NOTE_PREFIX}`);

export function isRamAgriLinkedProduct(product) {
  if (!product) return false;
  return Boolean(
    product.isRamAgriSales &&
      product.ramAgriCropId &&
      product.ramAgriVarietyId
  );
}

export function linkedRamAgriBatchIdFromNotes(notes) {
  const m = String(notes || "").match(/linkedRamAgriBatchId:([a-f0-9]{24})/i);
  return m ? m[1] : null;
}

/**
 * Mirror all active Ram Agri lots onto classic Batches for linked Products,
 * and set Product.currentStock from Ram Agri remaining qty.
 */
export async function syncLinkedInventoryFromRamAgri(
  cropId,
  varietyId,
  userId = null
) {
  if (!cropId || !varietyId) return { products: 0, batches: 0 };

  const crop = await RamAgriInputsProduct.findOne({
    _id: cropId,
    "varieties._id": varietyId,
  })
    .select("varieties.$")
    .lean();
  const linkedProductId = crop?.varieties?.[0]?.linkedInventoryProductId;
  const identityFilters = [
    {
      isRamAgriSales: true,
      ramAgriCropId: cropId,
      ramAgriVarietyId: varietyId,
    },
  ];
  if (linkedProductId && mongoose.Types.ObjectId.isValid(linkedProductId)) {
    identityFilters.push({
      _id: new mongoose.Types.ObjectId(linkedProductId),
    });
  }

  const products = await Product.find({
    isActive: true,
    category: { $regex: /^seeds$/i },
    $or: identityFilters,
  });

  if (!products.length) return { products: 0, batches: 0 };

  const ramBatches = await RamAgriBatch.find({
    ramAgriCropId: cropId,
    ramAgriVarietyId: varietyId,
  }).lean();

  const activeRem = ramBatches
    .filter(
      (b) =>
        Number(b.remainingQuantity) > 0 &&
        ["active", "expired"].includes(b.status)
    )
    .reduce((s, b) => s + (Number(b.remainingQuantity) || 0), 0);

  let batchWrites = 0;
  const actor =
    userId ||
    products[0].createdBy ||
    new mongoose.Types.ObjectId("000000000000000000000001");

  const productIds = products.map((p) => p._id);
  const existingMirrors = await Batch.find({
    product: { $in: productIds },
    notes: { $regex: `^${LINK_NOTE_PREFIX}` },
  });
  const mirrorByKey = new Map();
  const mirrorsByProduct = new Map();
  for (const b of existingMirrors) {
    const pid = String(b.product);
    const key = `${pid}:${b.notes}`;
    if (!mirrorByKey.has(key)) mirrorByKey.set(key, b);
    if (!mirrorsByProduct.has(pid)) mirrorsByProduct.set(pid, []);
    mirrorsByProduct.get(pid).push(b);
  }

  const lotNumber = (rb) => String(rb.batchNumber || "").trim() || `RAG-${rb._id}`;
  const missingLotNumbers = new Set();
  for (const product of products) {
    for (const rb of ramBatches) {
      if (!mirrorByKey.has(`${product._id}:${LINK_NOTE_PREFIX}${rb._id}`)) {
        missingLotNumbers.add(lotNumber(rb));
      }
    }
  }
  const clashOwner = new Map();
  if (missingLotNumbers.size) {
    const clashes = await Batch.find({ batchNumber: { $in: [...missingLotNumbers] } })
      .select("batchNumber product")
      .lean();
    for (const c of clashes) clashOwner.set(c.batchNumber, String(c.product));
  }

  const now = new Date();
  const ramIds = new Set(ramBatches.map((rb) => String(rb._id)));

  for (const product of products) {
    product.isRamAgriSales = true;
    product.ramAgriCropId = cropId;
    product.ramAgriVarietyId = varietyId;
    product.currentStock = activeRem;
    product.stockUpdatedAt = now;
    if (userId) product.updatedBy = userId;
    const pendingSaves = [product.save({ validateBeforeSave: false })];

    for (const rb of ramBatches) {
      const rem = Math.max(0, Number(rb.remainingQuantity) || 0);
      const qty = Math.max(rem, Number(rb.quantity) || 0);
      const status =
        rem <= 0
          ? "exhausted"
          : rb.status === "expired"
            ? "expired"
            : rb.status === "blocked"
              ? "blocked"
              : "active";

      const note = `${LINK_NOTE_PREFIX}${rb._id}`;
      let classic = mirrorByKey.get(`${product._id}:${note}`);

      if (!classic) {
        // Prefer same lot number; fall back if unique collision
        let batchNumber = lotNumber(rb);
        const owner = clashOwner.get(batchNumber);
        if (owner && owner !== String(product._id)) {
          batchNumber = `RAG-${batchNumber}`;
        }
        classic = new Batch({
          batchNumber,
          product: product._id,
          manufactureDate: rb.manufactureDate,
          expiryDate: rb.expiryDate,
          receivedDate: rb.receivedDate || now,
          purchasePrice: Number(rb.purchasePrice) || 0,
          quantity: qty || rem,
          remainingQuantity: rem,
          unit: rb.unit || product.primaryUnit,
          status,
          notes: note,
          createdBy: actor,
        });
        mirrorByKey.set(`${product._id}:${note}`, classic);
      } else {
        classic.remainingQuantity = rem;
        classic.quantity = Math.max(Number(classic.quantity) || 0, qty, rem);
        classic.expiryDate = rb.expiryDate || classic.expiryDate;
        classic.manufactureDate = rb.manufactureDate || classic.manufactureDate;
        classic.status = status;
        if (!classic.unit) classic.unit = rb.unit || product.primaryUnit;
        if (!classic.createdBy) classic.createdBy = actor;
        // Same transition the Batch pre-save hook applies, so skipping unchanged rows stays equivalent.
        if (rem > 0 && classic.expiryDate && classic.expiryDate < now) {
          classic.status = "expired";
        }
      }

      if (classic.isNew || classic.isModified()) {
        pendingSaves.push(classic.save());
        batchWrites += 1;
      }
    }

    // Exhaust mirrors whose Ram Agri lot disappeared
    for (const b of mirrorsByProduct.get(String(product._id)) || []) {
      const rid = linkedRamAgriBatchIdFromNotes(b.notes);
      if (rid && !ramIds.has(rid) && b.remainingQuantity > 0) {
        b.remainingQuantity = 0;
        b.status = "exhausted";
        pendingSaves.push(b.save());
        batchWrites += 1;
      }
    }

    await Promise.all(pendingSaves);
  }

  return { products: products.length, batches: batchWrites };
}

/**
 * After sowing deducts a classic mirror batch, also deduct the linked Ram Agri lot.
 */
export async function deductLinkedRamAgriBatchForClassicBatch(
  classicBatch,
  qty,
  userId = null
) {
  const ramId = linkedRamAgriBatchIdFromNotes(classicBatch?.notes);
  if (!ramId) return null;
  const rb = await RamAgriBatch.findById(ramId);
  if (!rb) return null;
  const take = Math.min(Number(qty) || 0, Number(rb.remainingQuantity) || 0);
  if (take <= 0) return rb;
  rb.remainingQuantity = Math.max(0, (Number(rb.remainingQuantity) || 0) - take);
  if (rb.remainingQuantity <= 0) rb.status = "exhausted";
  await rb.save();

  // Refresh variety + mirrors (avoid recursive mirror rewrite fighting this deduct:
  // only update variety currentStock here; caller may sync)
  const { syncVarietyStockFromBatches } = await import(
    "./ramAgriBatchInventory.service.js"
  );
  await syncVarietyStockFromBatches(rb.ramAgriCropId, rb.ramAgriVarietyId, userId);
  return rb;
}
