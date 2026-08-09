import mongoose from "mongoose";
import Product from "../models/product.model.js";
import { upsertVarietyInventoryLink } from "./ramAgriVarietyInventoryLink.service.js";
import {
  addBiotechSubtypeLink,
  addRamAgriSubtypeLink,
  removeSubtypeInventoryLink,
  listSubtypeInventoryLinks,
  enrichLinkRows,
} from "./subtypeInventoryLink.service.js";

/**
 * Add a seed link to a nursery plant + subtype (1:N — biotech and agri can coexist).
 * source: 'biotech' | 'agri'
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
    // Keep product sync for sowing cards when plant packing product is needed.
    const result = await upsertVarietyInventoryLink({
      cropId,
      varietyId,
      plantId,
      subtypeId,
      productId: productId || undefined,
      tentativePlantsPerPacket,
      userId,
      allowMultiLink: true,
    });
    const link = await addRamAgriSubtypeLink({
      plantId,
      subtypeId,
      cropId,
      varietyId,
      userId,
    });
    // If upsert created/updated a Biotech SKU, also register BIOTECH link.
    if (result?.product?._id) {
      try {
        await addBiotechSubtypeLink({
          plantId,
          subtypeId,
          productId: result.product._id,
          userId,
        });
      } catch {
        /* already linked */
      }
    }
    return { source: "agri", link, ...result };
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

    const link = await addBiotechSubtypeLink({
      plantId,
      subtypeId,
      productId: product._id,
      userId,
    });

    return {
      source: "biotech",
      link,
      product: product.toObject ? product.toObject() : product,
    };
  }

  throw new Error('Invalid source — use "biotech" or "agri"');
}

export async function unassignSubtypeSeed(params) {
  return removeSubtypeInventoryLink(params);
}

export async function listLinksForSubtype(plantId, subtypeId) {
  return enrichLinkRows(await listSubtypeInventoryLinks(plantId, subtypeId));
}
