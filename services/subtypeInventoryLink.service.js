import mongoose from "mongoose";
import SubtypeInventoryLink from "../models/subtypeInventoryLink.model.js";
import Product from "../models/product.model.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";

/**
 * List active multi-links for a CMS plant + subtype.
 */
export async function listSubtypeInventoryLinks(plantId, subtypeId) {
  if (!plantId || !subtypeId) return [];
  return SubtypeInventoryLink.find({
    plantId,
    subtypeId,
    isActive: true,
  })
    .populate("productId", "name code currentStock category primaryUnit")
    .populate("ramAgriCropId", "cropName productType varieties")
    .sort({ source: 1, createdAt: 1 })
    .lean();
}

/**
 * Enrich link rows with display labels / variety names / stock hints.
 */
export function enrichLinkRows(links = []) {
  return (links || []).map((link) => {
    const row = { ...link };
    if (link.source === "BIOTECH" && link.productId) {
      const p = link.productId;
      row.displayName = p?.name || link.label || "Biotech product";
      row.availableStock = Number(p?.currentStock) || 0;
    } else if (link.source === "RAM_AGRI") {
      const crop = link.ramAgriCropId;
      const variety = (crop?.varieties || []).find(
        (v) => String(v._id) === String(link.ramAgriVarietyId)
      );
      row.displayName =
        link.label ||
        (crop && variety
          ? `${crop.cropName} — ${variety.name}`
          : "Ram Agri variety");
      row.ramAgriVarietyName = variety?.name || "";
      row.availableStock = Number(variety?.currentStock) || 0;
    }
    return row;
  });
}

/**
 * Add a Biotech product link (1:N — does not clear other links).
 */
export async function addBiotechSubtypeLink({
  plantId,
  subtypeId,
  productId,
  label,
  userId,
}) {
  if (!mongoose.isValidObjectId(plantId) || !mongoose.isValidObjectId(subtypeId)) {
    throw new Error("Invalid plant or subtype ID");
  }
  if (!productId || !mongoose.isValidObjectId(productId)) {
    throw new Error("Select a Biotech seed product");
  }
  const product = await Product.findById(productId);
  if (!product) throw new Error("Product not found");
  if (!/^seeds$/i.test(String(product.category || ""))) {
    throw new Error("Only seed products can be assigned to a subtype");
  }

  // Keep classic fields for sowing resolve / backlog (product may sit on multiple subtypes via links;
  // still set plant/subtype on product for primary discovery).
  product.plantId = plantId;
  product.subtypeId = subtypeId;
  product.updatedBy = userId;
  await product.save({ validateBeforeSave: false });

  const link = await SubtypeInventoryLink.findOneAndUpdate(
    {
      plantId,
      subtypeId,
      source: "BIOTECH",
      productId,
    },
    {
      $set: {
        isActive: true,
        label: label || product.name || "",
        updatedBy: userId,
      },
      $setOnInsert: {
        createdBy: userId,
      },
    },
    { upsert: true, new: true }
  );

  return link.toObject ? link.toObject() : link;
}

/**
 * Add a Ram Agri variety link (1:N — does not clear other links).
 */
export async function addRamAgriSubtypeLink({
  plantId,
  subtypeId,
  cropId,
  varietyId,
  label,
  userId,
}) {
  if (!mongoose.isValidObjectId(plantId) || !mongoose.isValidObjectId(subtypeId)) {
    throw new Error("Invalid plant or subtype ID");
  }
  if (!cropId || !varietyId) {
    throw new Error("Select Ram Agri crop and variety");
  }

  const crop = await RamAgriInputsProduct.findById(cropId);
  if (!crop) throw new Error("Ram Agri crop not found");
  const variety = crop.varieties.id(varietyId);
  if (!variety) throw new Error("Ram Agri variety not found");

  // Sync legacy sowing fields on this variety only (do not clear siblings).
  variety.sowingPlantId = plantId;
  variety.sowingSubtypeId = subtypeId;
  crop.updatedBy = userId;
  await crop.save({ validateBeforeSave: false });

  const link = await SubtypeInventoryLink.findOneAndUpdate(
    {
      plantId,
      subtypeId,
      source: "RAM_AGRI",
      ramAgriCropId: cropId,
      ramAgriVarietyId: varietyId,
    },
    {
      $set: {
        isActive: true,
        label: label || `${crop.cropName} — ${variety.name}`,
        updatedBy: userId,
      },
      $setOnInsert: {
        createdBy: userId,
      },
    },
    { upsert: true, new: true }
  );

  return link.toObject ? link.toObject() : link;
}

/**
 * Soft-remove a link by id (or by composite keys).
 */
export async function removeSubtypeInventoryLink({
  linkId,
  plantId,
  subtypeId,
  source,
  productId,
  cropId,
  varietyId,
  userId,
}) {
  let link = null;
  if (linkId && mongoose.isValidObjectId(linkId)) {
    link = await SubtypeInventoryLink.findById(linkId);
  } else if (source === "BIOTECH" && productId) {
    link = await SubtypeInventoryLink.findOne({
      plantId,
      subtypeId,
      source: "BIOTECH",
      productId,
      isActive: true,
    });
  } else if (source === "RAM_AGRI" && varietyId) {
    link = await SubtypeInventoryLink.findOne({
      plantId,
      subtypeId,
      source: "RAM_AGRI",
      ramAgriCropId: cropId,
      ramAgriVarietyId: varietyId,
      isActive: true,
    });
  }
  if (!link) throw new Error("Link not found");

  link.isActive = false;
  link.updatedBy = userId;
  await link.save();

  // Soft-clear legacy fields when no other active link remains for that target.
  if (link.source === "BIOTECH" && link.productId) {
    const other = await SubtypeInventoryLink.countDocuments({
      productId: link.productId,
      source: "BIOTECH",
      isActive: true,
    });
    if (other === 0) {
      await Product.updateOne(
        { _id: link.productId },
        {
          $set: {
            plantId: null,
            subtypeId: null,
            plantSubtypeInfo: [],
            updatedBy: userId,
          },
        }
      );
    }
  }
  if (link.source === "RAM_AGRI" && link.ramAgriCropId && link.ramAgriVarietyId) {
    const other = await SubtypeInventoryLink.countDocuments({
      ramAgriCropId: link.ramAgriCropId,
      ramAgriVarietyId: link.ramAgriVarietyId,
      source: "RAM_AGRI",
      isActive: true,
    });
    if (other === 0) {
      const crop = await RamAgriInputsProduct.findById(link.ramAgriCropId);
      const variety = crop?.varieties?.id(link.ramAgriVarietyId);
      if (variety) {
        variety.sowingPlantId = undefined;
        variety.sowingSubtypeId = undefined;
        crop.updatedBy = userId;
        await crop.save({ validateBeforeSave: false });
      }
    }
  }

  return link.toObject ? link.toObject() : link;
}

/**
 * Candidates for sowing issue availability (multi-link).
 */
export async function getSubtypeInventoryCandidates(plantId, subtypeId) {
  const links = enrichLinkRows(await listSubtypeInventoryLinks(plantId, subtypeId));
  return {
    biotech: links.filter((l) => l.source === "BIOTECH"),
    ramAgri: links.filter((l) => l.source === "RAM_AGRI"),
    links,
  };
}
