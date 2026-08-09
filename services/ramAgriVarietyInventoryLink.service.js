/**
 * Map Ram Agri Input Master seed varieties to nursery plant/subtype packings.
 * Stock moves via internal PO (Ram Agri → Ram Biotech), not mirror sync.
 */
import mongoose from "mongoose";
import Product from "../models/product.model.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";
import { clearOtherAgriVarietiesOnPlantSubtype } from "./subtypeSeedEnforcement.service.js";

async function sumAvailablePackets(productIds) {
  if (!productIds?.length) return new Map();
  const { default: Batch } = await import("../models/batch.model.js");
  const ids = productIds.map((id) =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id))
  );
  const rows = await Batch.aggregate([
    {
      $match: {
        product: { $in: ids },
        status: { $in: ["active", "expired"] },
        remainingQuantity: { $gt: 0 },
      },
    },
    { $group: { _id: "$product", qty: { $sum: "$remainingQuantity" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), Number(r.qty) || 0]));
}

async function resolveSeedProductForLink({ plantId, subtypeId, productId, variety }) {
  if (productId && mongoose.isValidObjectId(productId)) {
    const selected = await Product.findById(productId);
    if (!selected) throw new Error("Selected inventory product not found");
    return selected;
  }

  const byPlantList = await Product.find({
    plantId,
    subtypeId,
    category: { $regex: /^seeds$/i },
    isActive: { $ne: false },
  });
  if (byPlantList.length) {
    const stockMap = await sumAvailablePackets(byPlantList.map((p) => p._id));
    byPlantList.sort(
      (a, b) =>
        (stockMap.get(String(b._id)) || 0) - (stockMap.get(String(a._id)) || 0)
    );
    return byPlantList[0];
  }

  if (variety.linkedInventoryProductId && mongoose.isValidObjectId(variety.linkedInventoryProductId)) {
    const linked = await Product.findById(variety.linkedInventoryProductId);
    if (linked && /^seeds$/i.test(String(linked.category || ""))) {
      return linked;
    }
  }

  return null;
}

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();

async function loadPlantSubtype(plantId, subtypeId) {
  const { default: PlantCms } = await import("../models/plantCms.model.js");
  const plant = await PlantCms.findById(plantId).select("name subtypes sowingAllowed").lean();
  if (!plant) return { error: "Plant not found" };
  const subtype = plant.subtypes?.find((st) => String(st._id) === String(subtypeId));
  if (!subtype) return { error: "Subtype not found for this plant" };
  return { plant, subtype };
}

async function loadVarietyOnCrop(cropId, varietyId) {
  const crop = await RamAgriInputsProduct.findById(cropId);
  if (!crop) return { error: "Crop not found" };
  const variety = crop.varieties.id(varietyId);
  if (!variety) return { error: "Variety not found" };
  return { crop, variety };
}

export async function getVarietyInventoryLink(cropId, varietyId) {
  if (!mongoose.isValidObjectId(cropId) || !mongoose.isValidObjectId(varietyId)) {
    return null;
  }

  const { crop, variety, error } = await loadVarietyOnCrop(cropId, varietyId);
  if (error) return null;

  const plantId = variety.sowingPlantId ? String(variety.sowingPlantId) : "";
  const subtypeId = variety.sowingSubtypeId ? String(variety.sowingSubtypeId) : "";

  let product = null;
  if (variety.linkedInventoryProductId) {
    product = await Product.findById(variety.linkedInventoryProductId)
      .select("_id code name plantId subtypeId tentativePlantsPerPacket conversionFactor currentStock")
      .lean();
  }
  if (!product && plantId && subtypeId) {
    product = await Product.findOne({
      plantId,
      subtypeId,
      category: { $regex: /^seeds$/i },
      isActive: { $ne: false },
    })
      .select("_id code name plantId subtypeId tentativePlantsPerPacket conversionFactor currentStock")
      .lean();
  }

  if (!plantId && !subtypeId && !product) {
    return { linked: false, product: null, plant: null, subtype: null };
  }

  let plant = null;
  let subtype = null;
  const pid = plantId || product?.plantId;
  const sid = subtypeId || product?.subtypeId;
  if (pid && sid) {
    const resolved = await loadPlantSubtype(pid, sid);
    if (!resolved.error) {
      plant = { _id: resolved.plant._id, name: resolved.plant.name };
      subtype = { _id: resolved.subtype._id, name: resolved.subtype.name };
    }
  }

  const availableByProduct = product?._id
    ? await sumAvailablePackets([product._id])
    : new Map();
  const availablePackets = product?._id
    ? availableByProduct.get(String(product._id)) ?? 0
    : 0;

  return {
    linked: Boolean(plantId && subtypeId),
    product: product
      ? {
          _id: product._id,
          code: product.code,
          name: product.name,
          currentStock: product.currentStock,
          availablePackets,
          tentativePlantsPerPacket: product.tentativePlantsPerPacket,
          conversionFactor: product.conversionFactor,
        }
      : null,
    availablePackets,
    plantId: plantId || (product?.plantId ? String(product.plantId) : ""),
    subtypeId: subtypeId || (product?.subtypeId ? String(product.subtypeId) : ""),
    plant,
    subtype,
  };
}

async function uniqueProductCode(base) {
  let code = base.slice(0, 48).toUpperCase();
  let i = 0;
  while (await Product.findOne({ code }).select("_id").lean()) {
    i += 1;
    code = `${base.slice(0, 40)}-${i}`.toUpperCase();
  }
  return code;
}

/** Resolve Ram Agri crop/variety for a nursery seed product (sowing PO transfer). */
export async function resolveRamAgriForSeedProduct(product) {
  if (!product) return null;
  if (product.ramAgriCropId && product.ramAgriVarietyId) {
    return {
      cropId: product.ramAgriCropId,
      varietyId: product.ramAgriVarietyId,
    };
  }
  if (product._id) {
    const byLinkedProduct = await RamAgriInputsProduct.findOne({
      productType: "seed",
      varieties: {
        $elemMatch: {
          linkedInventoryProductId: product._id,
          isActive: { $ne: false },
        },
      },
    });
    if (byLinkedProduct) {
      const linkedVariety = byLinkedProduct.varieties.find(
        (v) => String(v.linkedInventoryProductId) === String(product._id)
      );
      if (linkedVariety) {
        return {
          cropId: byLinkedProduct._id,
          varietyId: linkedVariety._id,
          crop: byLinkedProduct,
          variety: linkedVariety,
        };
      }
    }
  }

  if (!product.plantId || !product.subtypeId) return null;

  const crop = await RamAgriInputsProduct.findOne({
    productType: "seed",
    varieties: {
      $elemMatch: {
        sowingPlantId: product.plantId,
        sowingSubtypeId: product.subtypeId,
        isActive: { $ne: false },
      },
    },
  });
  if (!crop) return null;

  const variety = crop.varieties.find(
    (v) =>
      String(v.sowingPlantId) === String(product.plantId) &&
      String(v.sowingSubtypeId) === String(product.subtypeId)
  );
  if (!variety) return null;

  return { cropId: crop._id, varietyId: variety._id, crop, variety };
}

/**
 * Map variety → plant/subtype seed product (no Ram Agri stock mirror).
 */
export async function upsertVarietyInventoryLink({
  cropId,
  varietyId,
  plantId,
  subtypeId,
  productId,
  tentativePlantsPerPacket,
  userId,
}) {
  if (!mongoose.isValidObjectId(cropId) || !mongoose.isValidObjectId(varietyId)) {
    throw new Error("Invalid crop or variety ID");
  }
  if (!plantId || !subtypeId) {
    throw new Error("Plant and subtype are required to link sowing inventory");
  }
  if (!mongoose.isValidObjectId(plantId) || !mongoose.isValidObjectId(subtypeId)) {
    throw new Error("Invalid plant or subtype ID");
  }

  const { crop, variety, error: cropErr } = await loadVarietyOnCrop(cropId, varietyId);
  if (cropErr) throw new Error(cropErr);

  const pType = crop.productType || "seed";
  if (pType !== "seed") {
    throw new Error("Inventory sowing link is only supported for seed varieties");
  }

  const { plant, subtype, error: plantErr } = await loadPlantSubtype(plantId, subtypeId);
  if (plantErr) throw new Error(plantErr);

  const primaryUnitId = variety.primaryUnit?._id || variety.primaryUnit;
  if (!primaryUnitId) throw new Error("Variety primary unit is required before linking");

  let product = await resolveSeedProductForLink({
    plantId,
    subtypeId,
    productId,
    variety,
  });

  const tpp = Number(tentativePlantsPerPacket);
  const cf =
    Number.isFinite(tpp) && tpp > 0
      ? tpp
      : Number(product?.conversionFactor) > 0
        ? Number(product.conversionFactor)
        : 1000;

  const displayName = `${subtype.name}`.trim() || variety.name;

  if (!product) {
    const codeBase = `RAG-${norm(crop.cropName)}-${norm(variety.name)}` || "RAG-SEED";
    const code = await uniqueProductCode(codeBase);
    product = new Product({
      code,
      name: displayName,
      description: `Sowing packing for ${crop.cropName} / ${variety.name}`,
      category: "seeds",
      purpose: "production",
      plantId,
      subtypeId,
      primaryUnit: primaryUnitId,
      secondaryUnit: variety.secondaryUnit?._id || variety.secondaryUnit || undefined,
      conversionFactor: variety.conversionFactor || cf,
      tentativePlantsPerPacket: Number.isFinite(tpp) && tpp > 0 ? tpp : undefined,
      minStockLevel: 0,
      currentStock: 0,
      isActive: true,
      isRamAgriSales: false,
      ramAgriCropId: null,
      ramAgriVarietyId: null,
      createdBy: userId,
    });
  } else {
    product.plantId = plantId;
    product.subtypeId = subtypeId;
    product.category = "seeds";
    product.isActive = true;
    product.isRamAgriSales = false;
    product.ramAgriCropId = null;
    product.ramAgriVarietyId = null;
    if (!product.primaryUnit) product.primaryUnit = primaryUnitId;
    if (Number.isFinite(tpp) && tpp > 0) {
      product.tentativePlantsPerPacket = tpp;
      product.conversionFactor = tpp;
    }
    if (!product.name?.trim()) product.name = displayName;
    product.updatedBy = userId;
  }

  await product.save({ validateBeforeSave: false });

  await clearOtherAgriVarietiesOnPlantSubtype(cropId, varietyId, plantId, subtypeId, userId);

  // Avoid duplicate 0-stock packings on same plant+subtype in sowing cards
  await Product.updateMany(
    {
      _id: { $ne: product._id },
      plantId,
      subtypeId,
      category: { $regex: /^seeds$/i },
    },
    {
      $set: {
        plantId: null,
        subtypeId: null,
        plantSubtypeInfo: [],
        updatedBy: userId,
      },
    }
  );

  variety.sowingPlantId = plantId;
  variety.sowingSubtypeId = subtypeId;
  variety.linkedInventoryProductId = product._id;
  crop.updatedBy = userId;
  await crop.save({ validateBeforeSave: false });

  return {
    product: product.toObject ? product.toObject() : product,
    plant: { _id: plant._id, name: plant.name },
    subtype: { _id: subtype._id, name: subtype.name },
  };
}

/** Attach sowing mapping summary onto crop variety subdocs. */
export async function attachInventoryLinksToCrops(crops) {
  if (!Array.isArray(crops) || !crops.length) return crops;

  const productIds = [];
  for (const crop of crops) {
    for (const v of crop.varieties || []) {
      if (v.linkedInventoryProductId) productIds.push(v.linkedInventoryProductId);
    }
  }

  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds } })
        .select("_id code name plantId subtypeId tentativePlantsPerPacket currentStock")
        .lean()
    : [];
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const availableByProduct = await sumAvailablePackets(productIds);

  return crops.map((crop) => {
    const doc = crop.toObject ? crop.toObject() : { ...crop };
    doc.varieties = (doc.varieties || []).map((v) => {
      const linked =
        v.sowingPlantId && v.sowingSubtypeId
          ? {
              linked: true,
              plantId: v.sowingPlantId,
              subtypeId: v.sowingSubtypeId,
              productId: v.linkedInventoryProductId,
            }
          : { linked: false };
      const prod = v.linkedInventoryProductId
        ? productById.get(String(v.linkedInventoryProductId))
        : null;
      const availablePackets = prod
        ? availableByProduct.get(String(prod._id)) ?? 0
        : 0;
      return {
        ...v,
        inventoryLink: prod
          ? {
              ...linked,
              productCode: prod.code,
              productName: prod.name,
              availablePackets,
              currentStock: prod.currentStock,
            }
          : linked,
      };
    });
    return doc;
  });
}

export async function clearVarietyInventoryLink(cropId, varietyId, userId) {
  const { crop, variety, error } = await loadVarietyOnCrop(cropId, varietyId);
  if (error) throw new Error(error);

  variety.sowingPlantId = undefined;
  variety.sowingSubtypeId = undefined;
  variety.linkedInventoryProductId = undefined;
  crop.updatedBy = userId;
  await crop.save({ validateBeforeSave: false });

  const result = await Product.updateMany(
    { ramAgriCropId: cropId, ramAgriVarietyId: varietyId },
    {
      $set: {
        isRamAgriSales: false,
        ramAgriCropId: null,
        ramAgriVarietyId: null,
        updatedBy: userId,
      },
    }
  );

  return { modified: result.modifiedCount || 0, varietyCleared: true };
}

/** Bulk dislink all plant/seed mappings and legacy Ram Agri product flags. */
export async function clearAllVarietyInventoryLinks(userId) {
  const productResult = await Product.updateMany(
    {
      $or: [
        { isRamAgriSales: true },
        { ramAgriCropId: { $ne: null } },
        { ramAgriVarietyId: { $ne: null } },
      ],
    },
    {
      $set: {
        isRamAgriSales: false,
        ramAgriCropId: null,
        ramAgriVarietyId: null,
        updatedBy: userId,
      },
    }
  );

  // Also remove Plant CMS links from all seed inventory products (stock/batches unchanged)
  const cmsUnlinkResult = await Product.updateMany(
    {
      category: { $regex: /^seeds$/i },
      $or: [{ plantId: { $ne: null } }, { subtypeId: { $ne: null } }],
    },
    {
      $set: {
        plantId: null,
        subtypeId: null,
        plantSubtypeInfo: [],
        updatedBy: userId,
      },
    }
  );

  const crops = await RamAgriInputsProduct.find({ productType: "seed" });
  let varietiesCleared = 0;
  for (const crop of crops) {
    let dirty = false;
    for (const v of crop.varieties || []) {
      if (v.sowingPlantId || v.sowingSubtypeId || v.linkedInventoryProductId) {
        v.sowingPlantId = undefined;
        v.sowingSubtypeId = undefined;
        v.linkedInventoryProductId = undefined;
        dirty = true;
        varietiesCleared += 1;
      }
    }
    if (dirty) {
      crop.updatedBy = userId;
      await crop.save({ validateBeforeSave: false });
    }
  }

  return {
    productsModified: productResult.modifiedCount || 0,
    cmsSeedLinksCleared: cmsUnlinkResult.modifiedCount || 0,
    varietiesCleared,
  };
}

async function loadSeedProduct(productId) {
  if (!mongoose.isValidObjectId(productId)) {
    throw new Error("Invalid product ID");
  }
  const product = await Product.findById(productId);
  if (!product) throw new Error("Product not found");
  if (!/^seeds$/i.test(String(product.category || ""))) {
    throw new Error("Only seed products can link to Ram Agri varieties");
  }
  return product;
}

/** Biotech-initiated: read Agri link for a nursery seed product. */
export async function getProductAgriLink(productId) {
  const product = await loadSeedProduct(productId);
  const resolved = await resolveRamAgriForSeedProduct(product);

  let agri = null;
  if (resolved?.crop && resolved?.variety) {
    agri = {
      cropId: resolved.crop._id,
      cropName: resolved.crop.cropName,
      varietyId: resolved.variety._id,
      varietyName: resolved.variety.name,
      agriStock: resolved.variety.currentStock || 0,
    };
  } else if (resolved?.cropId) {
    const crop = await RamAgriInputsProduct.findById(resolved.cropId).lean();
    const variety = crop?.varieties?.find((v) => String(v._id) === String(resolved.varietyId));
    if (crop && variety) {
      agri = {
        cropId: crop._id,
        cropName: crop.cropName,
        varietyId: variety._id,
        varietyName: variety.name,
        agriStock: variety.currentStock || 0,
      };
    }
  }

  const { getBiotechTransferHistory } = await import("./biotechSeedMaster.service.js");
  const transferHistory = await getBiotechTransferHistory(productId, 8);

  return {
    linked: Boolean(agri),
    product: {
      _id: product._id,
      code: product.code,
      name: product.name,
      currentStock: product.currentStock || 0,
      plantId: product.plantId,
      subtypeId: product.subtypeId,
      tentativePlantsPerPacket: product.tentativePlantsPerPacket,
    },
    agri,
    transferHistory,
  };
}

/** Biotech-initiated: link product to Ram Agri seed variety. */
export async function linkProductToAgriVariety({
  productId,
  cropId,
  varietyId,
  tentativePlantsPerPacket,
  userId,
}) {
  const product = await loadSeedProduct(productId);
  if (!product.plantId || !product.subtypeId) {
    throw new Error("Product must have plant and subtype assigned before linking to Ram Agri");
  }

  return upsertVarietyInventoryLink({
    cropId,
    varietyId,
    plantId: product.plantId,
    subtypeId: product.subtypeId,
    productId: product._id,
    tentativePlantsPerPacket,
    userId,
  });
}

/** Biotech-initiated: remove Agri link for a product. */
export async function clearProductAgriLink(productId, userId) {
  const product = await loadSeedProduct(productId);
  const resolved = await resolveRamAgriForSeedProduct(product);
  if (!resolved?.cropId || !resolved?.varietyId) {
    return { cleared: false, message: "No Agri link found for this product" };
  }
  const result = await clearVarietyInventoryLink(resolved.cropId, resolved.varietyId, userId);
  return { cleared: true, ...result };
}
