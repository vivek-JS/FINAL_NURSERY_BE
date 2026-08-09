import mongoose from 'mongoose';
import Product from '../models/product.model.js';

async function nextSeedProductCode() {
  const prefix = 'SEED';
  const base = await Product.countDocuments({ category: { $regex: /^seeds$/i } });
  for (let i = 0; i < 200; i++) {
    const code = `${prefix}${String(base + 1 + i).padStart(6, '0')}`;
    const exists = await Product.exists({ code });
    if (!exists) return code;
  }
  throw new Error('Could not generate unique seed product code');
}

/**
 * Ensure a Ram Biotech Product exists for a master variety row.
 */
export async function syncProductForBiotechVariety({
  plantDoc,
  variety,
  userId,
}) {
  const primaryUnit = variety.primaryUnit;
  if (!primaryUnit) throw new Error('Primary unit is required for inventory product');

  const productName = `${plantDoc.plantName} - ${variety.name}`.trim();
  const payload = {
    name: productName,
    description: variety.description || '',
    category: 'seeds',
    primaryUnit,
    secondaryUnit: variety.secondaryUnit || undefined,
    conversionFactor: variety.conversionFactor || 1,
    plantId: variety.sowingPlantId || undefined,
    subtypeId: variety.sowingSubtypeId || undefined,
    tentativePlantsPerPacket: variety.tentativePlantsPerPacket || undefined,
    isActive: variety.isActive !== false,
    updatedBy: userId,
  };

  if (variety.linkedInventoryProductId && mongoose.isValidObjectId(variety.linkedInventoryProductId)) {
    const existing = await Product.findById(variety.linkedInventoryProductId);
    if (existing) {
      Object.assign(existing, payload);
      await existing.save({ validateModifiedOnly: true });
      return existing;
    }
  }

  const code = await nextSeedProductCode();
  const created = await Product.create({
    ...payload,
    code,
    createdBy: userId,
  });
  variety.linkedInventoryProductId = created._id;
  return created;
}
