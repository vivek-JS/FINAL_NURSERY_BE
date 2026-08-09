/**
 * Keep inventory Product + classic Batch in sync with Ram Agri variety stock
 * so sowing (Product + Batch) can issue company seed from Ram Agri lots.
 */
import mongoose from "mongoose";
import RamAgriBatch from "../models/ramAgriBatch.model.js";
import Product from "../models/product.model.js";
import Batch from "../models/batch.model.js";

const LINK_NOTE_PREFIX = "linkedRamAgriBatchId:";

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

  const products = await Product.find({
    isActive: true,
    isRamAgriSales: true,
    ramAgriCropId: cropId,
    ramAgriVarietyId: varietyId,
    category: { $regex: /^seeds$/i },
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

  for (const product of products) {
    product.currentStock = activeRem;
    product.stockUpdatedAt = new Date();
    if (userId) product.updatedBy = userId;
    await product.save({ validateBeforeSave: false });

    const seenRamIds = new Set();
    for (const rb of ramBatches) {
      seenRamIds.add(String(rb._id));
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
      let classic = await Batch.findOne({
        product: product._id,
        notes: note,
      });

      if (!classic) {
        // Prefer same lot number; fall back if unique collision
        let batchNumber = String(rb.batchNumber || "").trim() || `RAG-${rb._id}`;
        const clash = await Batch.findOne({ batchNumber }).select("_id product").lean();
        if (clash && String(clash.product) !== String(product._id)) {
          batchNumber = `RAG-${batchNumber}`;
        }
        classic = new Batch({
          batchNumber,
          product: product._id,
          manufactureDate: rb.manufactureDate,
          expiryDate: rb.expiryDate,
          receivedDate: rb.receivedDate || new Date(),
          purchasePrice: Number(rb.purchasePrice) || 0,
          quantity: qty || rem,
          remainingQuantity: rem,
          unit: rb.unit || product.primaryUnit,
          status,
          notes: note,
          createdBy: actor,
        });
      } else {
        classic.remainingQuantity = rem;
        classic.quantity = Math.max(Number(classic.quantity) || 0, qty, rem);
        classic.expiryDate = rb.expiryDate || classic.expiryDate;
        classic.manufactureDate = rb.manufactureDate || classic.manufactureDate;
        classic.status = status;
        if (!classic.unit) classic.unit = rb.unit || product.primaryUnit;
      }

      await classic.save();
      batchWrites += 1;
    }

    // Exhaust mirrors whose Ram Agri lot disappeared
    const orphans = await Batch.find({
      product: product._id,
      notes: { $regex: `^${LINK_NOTE_PREFIX}` },
    });
    for (const b of orphans) {
      const rid = linkedRamAgriBatchIdFromNotes(b.notes);
      if (rid && !seenRamIds.has(rid) && b.remainingQuantity > 0) {
        b.remainingQuantity = 0;
        b.status = "exhausted";
        await b.save();
        batchWrites += 1;
      }
    }
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
