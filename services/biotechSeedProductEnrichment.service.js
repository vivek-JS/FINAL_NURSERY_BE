import mongoose from 'mongoose';
import Product from '../models/product.model.js';
import { buildAgriLinkByProductIdMap } from './biotechSeedMaster.service.js';

async function batchCountByProduct(productIds) {
  if (!productIds?.length) return new Map();
  const { default: Batch } = await import('../models/batch.model.js');
  const ids = productIds.map((id) =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id))
  );
  const rows = await Batch.aggregate([
    { $match: { product: { $in: ids }, status: { $ne: 'blocked' } } },
    { $group: { _id: '$product', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), Number(r.count) || 0]));
}

function attachVarietyInventoryMeta(variety, productMap, linkMap, batchMap) {
  const productId = variety.linkedInventoryProductId
    ? String(variety.linkedInventoryProductId)
    : '';
  const product = productId ? productMap.get(productId) : null;
  const agri = productId ? linkMap.get(productId) : null;

  return {
    ...variety,
    inventoryLink: product
      ? {
          linked: true,
          productId: product._id,
          productCode: product.code,
          productName: product.name,
          currentStock: product.currentStock || 0,
          batchCount: batchMap.get(String(product._id)) || 0,
          plantId: variety.sowingPlantId || product.plantId,
          subtypeId: variety.sowingSubtypeId || product.subtypeId,
        }
      : { linked: false },
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

export async function enrichBiotechSeedPlants(plants) {
  if (!plants?.length) return plants;

  const productIds = [];
  for (const plant of plants) {
    for (const v of plant.varieties || []) {
      if (v.linkedInventoryProductId) productIds.push(v.linkedInventoryProductId);
    }
  }

  const [products, linkMap, batchMap] = await Promise.all([
    productIds.length
      ? Product.find({ _id: { $in: productIds } })
          .select('_id code name currentStock plantId subtypeId')
          .lean()
      : [],
    buildAgriLinkByProductIdMap(),
    batchCountByProduct(productIds),
  ]);

  const productMap = new Map(products.map((p) => [String(p._id), p]));

  return plants.map((plant) => ({
    ...plant,
    varieties: (plant.varieties || []).map((v) =>
      attachVarietyInventoryMeta(
        typeof v.toObject === 'function' ? v.toObject() : v,
        productMap,
        linkMap,
        batchMap
      )
    ),
  }));
}
