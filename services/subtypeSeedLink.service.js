import mongoose from "mongoose";
import Product from "../models/product.model.js";
import { upsertVarietyInventoryLink } from "./ramAgriVarietyInventoryLink.service.js";
import {
  clearOtherSeedProductsOnSubtype,
  clearOtherAgriVarietiesOnPlantSubtype,
  clearAllAgriVarietiesOnPlantSubtype,
} from "./subtypeSeedEnforcement.service.js";

/**
 * Assign exactly one seed to a nursery plant + subtype.
 * source: 'biotech' = pick existing Biotech SKU | 'agri' = Ram Agri Input variety
 */
export async function assignSubtypeSeed({
  plantId,
  subtypeId,
  source,
  productId,
  cropId,
  varietyId,
  tentativePlantsPerPacket,
  userId,
}) {
  if (!mongoose.isValidObjectId(plantId) || !mongoose.isValidObjectId(subtypeId)) {
    throw new Error("Invalid plant or subtype ID");
  }

  if (source === "agri") {
    if (!cropId || !varietyId) {
      throw new Error("Select Ram Agri crop and variety");
    }
    await clearOtherAgriVarietiesOnPlantSubtype(cropId, varietyId, plantId, subtypeId, userId);
    const result = await upsertVarietyInventoryLink({
      cropId,
      varietyId,
      plantId,
      subtypeId,
      productId: productId || undefined,
      tentativePlantsPerPacket,
      userId,
    });
    return { source: "agri", ...result };
  }

  if (source === "biotech") {
    if (!productId || !mongoose.isValidObjectId(productId)) {
      throw new Error("Select a Biotech seed product");
    }
    const product = await Product.findById(productId);
    if (!product) throw new Error("Product not found");
    if (!/^seeds$/i.test(String(product.category || ""))) {
      throw new Error("Only seed products can be assigned to a subtype");
    }

    product.plantId = plantId;
    product.subtypeId = subtypeId;
    product.updatedBy = userId;
    await product.save({ validateBeforeSave: false });

    await clearOtherSeedProductsOnSubtype(product._id, plantId, subtypeId, userId);
    await clearAllAgriVarietiesOnPlantSubtype(plantId, subtypeId, userId);

    return {
      source: "biotech",
      product: product.toObject ? product.toObject() : product,
    };
  }

  throw new Error('Invalid source — use "biotech" or "agri"');
}
