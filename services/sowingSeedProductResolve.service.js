/**
 * Resolve nursery seed products for sowing gap cards — includes Ram Agri
 * variety sowing links (linkedInventoryProductId) even when product.plantId is unset.
 */
import Product from "../models/product.model.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";

export async function enrichSeedProductsFromRamAgriLinks(products, plantIds) {
  if (!plantIds?.length) return products;

  const byId = new Map(products.map((p) => [String(p._id), p]));
  const crops = await RamAgriInputsProduct.find({
    productType: "seed",
    varieties: {
      $elemMatch: {
        sowingPlantId: { $in: plantIds },
        sowingSubtypeId: { $exists: true, $ne: null },
        linkedInventoryProductId: { $exists: true, $ne: null },
        isActive: { $ne: false },
      },
    },
  })
    .select("varieties.sowingPlantId varieties.sowingSubtypeId varieties.linkedInventoryProductId varieties.isActive")
    .lean();

  const linkedIds = new Set();
  const linkMeta = [];
  for (const crop of crops) {
    for (const v of crop.varieties || []) {
      if (
        v.isActive === false ||
        !v.sowingPlantId ||
        !v.sowingSubtypeId ||
        !v.linkedInventoryProductId
      ) {
        continue;
      }
      if (!plantIds.some((pid) => String(pid) === String(v.sowingPlantId))) continue;
      linkedIds.add(String(v.linkedInventoryProductId));
      linkMeta.push({
        productId: String(v.linkedInventoryProductId),
        plantId: String(v.sowingPlantId),
        subtypeId: String(v.sowingSubtypeId),
      });
    }
  }

  if (!linkedIds.size) return products;

  const missingIds = [...linkedIds].filter((id) => !byId.has(id));
  if (!missingIds.length) return products;

  const linkedProducts = await Product.find({
    _id: { $in: missingIds },
    category: { $regex: /^seeds$/i },
    isActive: { $ne: false },
  })
    .select("_id plantId subtypeId name code conversionFactor tentativePlantsPerPacket")
    .lean();

  const linkedById = new Map(linkedProducts.map((p) => [String(p._id), p]));
  const merged = [...products];

  for (const meta of linkMeta) {
    const base = linkedById.get(meta.productId);
    if (!base || byId.has(meta.productId)) continue;
    merged.push({
      ...base,
      plantId: meta.plantId,
      subtypeId: meta.subtypeId,
    });
    byId.set(meta.productId, merged[merged.length - 1]);
  }

  return merged;
}
