import mongoose from "mongoose";
import Product from "../models/product.model.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";

/** Unassign other seed SKUs from the same plant + subtype (keep one). */
export async function clearOtherSeedProductsOnSubtype(productId, plantId, subtypeId, userId) {
  if (!plantId || !subtypeId) return { modified: 0 };
  const filter = {
    plantId,
    subtypeId,
    category: { $regex: /^seeds$/i },
    isActive: { $ne: false },
  };
  if (productId && mongoose.isValidObjectId(productId)) {
    filter._id = { $ne: productId };
  }
  const result = await Product.updateMany(filter, {
    $set: {
      plantId: null,
      subtypeId: null,
      plantSubtypeInfo: [],
      updatedBy: userId,
    },
  });
  return { modified: result.modifiedCount || 0 };
}

/** Remove sowing map on other Agri seed varieties for this plant + subtype. */
export async function clearOtherAgriVarietiesOnPlantSubtype(
  keepCropId,
  keepVarietyId,
  plantId,
  subtypeId,
  userId
) {
  if (!plantId || !subtypeId) return { varietiesCleared: 0 };

  const crops = await RamAgriInputsProduct.find({ productType: "seed" });
  let varietiesCleared = 0;

  for (const crop of crops) {
    let dirty = false;
    for (const v of crop.varieties || []) {
      const isKeeper =
        keepCropId &&
        keepVarietyId &&
        String(crop._id) === String(keepCropId) &&
        String(v._id) === String(keepVarietyId);
      if (isKeeper) continue;

      if (
        String(v.sowingPlantId) === String(plantId) &&
        String(v.sowingSubtypeId) === String(subtypeId)
      ) {
        v.sowingPlantId = undefined;
        v.sowingSubtypeId = undefined;
        dirty = true;
        varietiesCleared += 1;
      }
    }
    if (dirty) {
      crop.updatedBy = userId;
      await crop.save({ validateBeforeSave: false });
    }
  }

  return { varietiesCleared };
}

export async function clearAllAgriVarietiesOnPlantSubtype(plantId, subtypeId, userId) {
  return clearOtherAgriVarietiesOnPlantSubtype(null, null, plantId, subtypeId, userId);
}
