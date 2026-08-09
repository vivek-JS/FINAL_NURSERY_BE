import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import {
  getVarietyInventoryLink,
  upsertVarietyInventoryLink,
  clearVarietyInventoryLink,
  clearAllVarietyInventoryLinks,
} from "../services/ramAgriVarietyInventoryLink.service.js";

export const getInventoryLink = catchAsync(async (req, res) => {
  const { id: cropId, varietyId } = req.params;
  if (!mongoose.isValidObjectId(cropId) || !mongoose.isValidObjectId(varietyId)) {
    throw new AppError("Invalid crop or variety ID", 400);
  }
  const data = await getVarietyInventoryLink(cropId, varietyId);
  return res.status(200).json(
    generateResponse("Success", "Inventory link fetched", data, undefined)
  );
});

export const upsertInventoryLink = catchAsync(async (req, res) => {
  const { id: cropId, varietyId } = req.params;
  const { plantId, subtypeId, productId, tentativePlantsPerPacket, clearLink } = req.body;
  const userId = req.user?._id || req.user?.id;

  if (!mongoose.isValidObjectId(cropId) || !mongoose.isValidObjectId(varietyId)) {
    throw new AppError("Invalid crop or variety ID", 400);
  }

  if (clearLink === true) {
    const cleared = await clearVarietyInventoryLink(cropId, varietyId, userId);
    return res.status(200).json(
      generateResponse("Success", "Inventory link removed", cleared, undefined)
    );
  }

  const result = await upsertVarietyInventoryLink({
    cropId,
    varietyId,
    plantId,
    subtypeId,
    productId,
    tentativePlantsPerPacket,
    userId,
  });

  return res.status(200).json(
    generateResponse("Success", "Inventory link saved", result, undefined)
  );
});

export const clearAllInventoryLinks = catchAsync(async (req, res) => {
  const userId = req.user?._id || req.user?.id;
  const cleared = await clearAllVarietyInventoryLinks(userId);
  return res.status(200).json(
    generateResponse("Success", "All plant/seed sowing links removed", cleared, undefined)
  );
});
