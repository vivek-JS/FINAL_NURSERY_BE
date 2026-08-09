import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import { buildBiotechSeedMaster } from "../services/biotechSeedMaster.service.js";
import { buildSeedDualInventoryLinks } from "../services/seedDualInventoryLinks.service.js";
import { assignSubtypeSeed } from "../services/subtypeSeedLink.service.js";
import { buildProductStockLedger } from "../services/biotechProductStockLedger.service.js";
import {
  getProductAgriLink,
  linkProductToAgriVariety,
  clearProductAgriLink,
} from "../services/ramAgriVarietyInventoryLink.service.js";

export const getBiotechSeedMaster = catchAsync(async (req, res) => {
  const unlinkedOnly = String(req.query.unlinkedOnly || "").toLowerCase() === "true";
  const data = await buildBiotechSeedMaster({ unlinkedOnly });
  return res.status(200).json(
    generateResponse("Success", "Biotech seed master fetched", data, undefined)
  );
});

export const getSeedDualInventoryLinks = catchAsync(async (req, res) => {
  const unlinkedOnly = String(req.query.unlinkedOnly || "").toLowerCase() === "true";
  const search = req.query.search || "";
  const data = await buildSeedDualInventoryLinks({ unlinkedOnly, search });
  return res.status(200).json(
    generateResponse("Success", "Seed dual inventory links fetched", data, undefined)
  );
});

export const postAssignSubtypeSeed = catchAsync(async (req, res, next) => {
  const { plantId, subtypeId, source, productId, cropId, varietyId, tentativePlantsPerPacket } =
    req.body;
  const userId = req.user?._id || req.user?.id;

  try {
    const result = await assignSubtypeSeed({
      plantId,
      subtypeId,
      source,
      productId,
      cropId,
      varietyId,
      tentativePlantsPerPacket,
      userId,
    });
    return res.status(200).json(
      generateResponse("Success", "Seed linked to subtype", result, undefined)
    );
  } catch (err) {
    return next(new AppError(err.message || "Failed to assign seed", 400));
  }
});

export const getProductAgriLinkHandler = catchAsync(async (req, res, next) => {
  const { productId } = req.params;
  if (!mongoose.isValidObjectId(productId)) {
    return next(new AppError("Invalid product ID", 400));
  }
  const data = await getProductAgriLink(productId);
  return res.status(200).json(
    generateResponse("Success", "Product Agri link fetched", data, undefined)
  );
});

export const patchProductAgriLinkHandler = catchAsync(async (req, res, next) => {
  const { productId } = req.params;
  const { cropId, varietyId, tentativePlantsPerPacket, clearLink } = req.body;
  const userId = req.user?._id || req.user?.id;

  if (!mongoose.isValidObjectId(productId)) {
    return next(new AppError("Invalid product ID", 400));
  }

  if (clearLink === true) {
    const cleared = await clearProductAgriLink(productId, userId);
    return res.status(200).json(
      generateResponse("Success", "Agri link removed", cleared, undefined)
    );
  }

  if (!cropId || !varietyId) {
    return next(new AppError("cropId and varietyId are required", 400));
  }
  if (!mongoose.isValidObjectId(cropId) || !mongoose.isValidObjectId(varietyId)) {
    return next(new AppError("Invalid crop or variety ID", 400));
  }

  try {
    const result = await linkProductToAgriVariety({
      productId,
      cropId,
      varietyId,
      tentativePlantsPerPacket,
      userId,
    });
    const linkData = await getProductAgriLink(productId);
    return res.status(200).json(
      generateResponse("Success", "Product linked to Ram Agri variety", { ...result, link: linkData }, undefined)
    );
  } catch (err) {
    return next(new AppError(err.message || "Failed to link product", 400));
  }
});

export const getProductStockLedgerHandler = catchAsync(async (req, res, next) => {
  const { productId } = req.params;
  const { startDate, endDate } = req.query;

  if (!mongoose.isValidObjectId(productId)) {
    return next(new AppError("Invalid product ID", 400));
  }

  try {
    const data = await buildProductStockLedger(productId, { startDate, endDate });
    return res.status(200).json(
      generateResponse("Success", "Product stock ledger fetched", data, undefined)
    );
  } catch (err) {
    return next(new AppError(err.message || "Failed to fetch ledger", 400));
  }
});
