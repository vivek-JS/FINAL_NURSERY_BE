import mongoose from "mongoose";
import Product from "../models/product.model.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";

async function batchCountByProduct(productIds) {
  if (!productIds?.length) return new Map();
  const { default: Batch } = await import("../models/batch.model.js");
  const ids = productIds.map((id) =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id))
  );
  const rows = await Batch.aggregate([
    { $match: { product: { $in: ids }, status: { $ne: "blocked" } } },
    { $group: { _id: "$product", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), Number(r.count) || 0]));
}

/** Reverse map: biotech productId → linked Agri variety. */
export async function buildAgriLinkByProductIdMap() {
  const crops = await RamAgriInputsProduct.find({ productType: "seed" })
    .select("cropName varieties.name varieties.linkedInventoryProductId varieties.currentStock varieties.isActive")
    .lean();

  const map = new Map();
  for (const crop of crops) {
    for (const v of crop.varieties || []) {
      if (v.isActive === false) continue;
      if (!v.linkedInventoryProductId) continue;
      map.set(String(v.linkedInventoryProductId), {
        cropId: crop._id,
        cropName: crop.cropName,
        varietyId: v._id,
        varietyName: v.name,
        agriStock: v.currentStock || 0,
      });
    }
  }
  return map;
}

function mapProductRow(product, linkMap, batchMap) {
  const agri = linkMap.get(String(product._id)) || null;
  return {
    _id: product._id,
    code: product.code,
    name: product.name,
    currentStock: product.currentStock || 0,
    batchCount: batchMap.get(String(product._id)) || 0,
    tentativePlantsPerPacket: product.tentativePlantsPerPacket,
    plantId: product.plantId,
    subtypeId: product.subtypeId,
    isActive: product.isActive !== false,
    agriLink: agri
      ? {
          linked: true,
          cropId: agri.cropId,
          cropName: agri.cropName,
          varietyId: agri.varietyId,
          varietyName: agri.varietyName,
          agriStock: agri.agriStock,
        }
      : { linked: false },
  };
}

export async function buildBiotechSeedMaster({ unlinkedOnly = false } = {}) {
  const { default: PlantCms } = await import("../models/plantCms.model.js");

  const [plants, seedProducts, linkMap] = await Promise.all([
    PlantCms.find({ sowingAllowed: { $ne: false } })
      .select("name subtypes.name subtypes._id subtypes.isActive")
      .sort({ name: 1 })
      .lean(),
    Product.find({
      category: { $regex: /^seeds$/i },
      isActive: { $ne: false },
    })
      .select("_id code name plantId subtypeId currentStock tentativePlantsPerPacket isActive")
      .lean(),
    buildAgriLinkByProductIdMap(),
  ]);

  const batchMap = await batchCountByProduct(seedProducts.map((p) => p._id));

  const productsByPlantSubtype = new Map();
  const unassigned = [];

  for (const p of seedProducts) {
    const row = mapProductRow(p, linkMap, batchMap);
    if (unlinkedOnly && row.agriLink?.linked) continue;

    if (p.plantId && p.subtypeId) {
      const key = `${p.plantId}:${p.subtypeId}`;
      if (!productsByPlantSubtype.has(key)) productsByPlantSubtype.set(key, []);
      productsByPlantSubtype.get(key).push(row);
    } else {
      unassigned.push(row);
    }
  }

  const plantRows = plants.map((plant) => {
    const subtypes = (plant.subtypes || [])
      .filter((st) => st.isActive !== false)
      .map((st) => {
        const key = `${plant._id}:${st._id}`;
        const products = (productsByPlantSubtype.get(key) || []).sort((a, b) =>
          String(a.code).localeCompare(String(b.code))
        );
        return {
          subtypeId: st._id,
          subtypeName: st.name,
          products,
          productCount: products.length,
          linkedCount: products.filter((pr) => pr.agriLink?.linked).length,
        };
      })
      .filter((st) => !unlinkedOnly || st.products.length > 0);

    const allProducts = subtypes.flatMap((st) => st.products);
    return {
      plantId: plant._id,
      plantName: plant.name,
      subtypes,
      productCount: allProducts.length,
      linkedCount: allProducts.filter((pr) => pr.agriLink?.linked).length,
    };
  }).filter((pl) => !unlinkedOnly || pl.productCount > 0);

  const flatProducts = [
    ...plantRows.flatMap((pl) => pl.subtypes.flatMap((st) => st.products)),
    ...unassigned,
  ];

  return {
    summary: {
      totalPlants: plantRows.length,
      totalProducts: flatProducts.length,
      linkedCount: flatProducts.filter((p) => p.agriLink?.linked).length,
      unlinkedCount: flatProducts.filter((p) => !p.agriLink?.linked).length,
    },
    plants: plantRows,
    unassigned: unlinkedOnly ? unassigned.filter((p) => !p.agriLink?.linked) : unassigned,
  };
}

/** Recent Agri → Biotech internal transfers for a seed product. */
export async function getBiotechTransferHistory(productId, limit = 10) {
  if (!mongoose.isValidObjectId(productId)) return [];

  const { default: InventoryTransaction } = await import("../models/inventoryTransaction.model.js");

  const rows = await InventoryTransaction.find({
    product: productId,
    transactionType: "inward",
    "metadata.isBiotechTransfer": true,
  })
    .sort({ transactionDate: -1 })
    .limit(limit)
    .select(
      "transactionNumber transactionDate quantity referenceNumber metadata reason balanceAfterTransaction"
    )
    .lean();

  return rows.map((r) => ({
    date: r.transactionDate,
    transactionNumber: r.transactionNumber,
    quantity: r.quantity,
    grnNumber: r.referenceNumber,
    reason: r.reason,
    cropId: r.metadata?.ramAgriCropId,
    varietyId: r.metadata?.ramAgriVarietyId,
    balanceAfter: r.balanceAfterTransaction,
  }));
}
