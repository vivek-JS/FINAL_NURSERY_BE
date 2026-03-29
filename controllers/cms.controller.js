import { getCMS, createCMS } from "../controllers/factory.controller.js";
import CMS from "../models/cms.model.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";

/*
  -controller function to create cms
  -it can be village, taluka, district, job title, crop, variety, vendor
*/

const createVillage = createCMS(CMS, "village");
const createTaluka = createCMS(CMS, "taluka");
const createDistrict = createCMS(CMS, "district");
const createJobTitle = createCMS(CMS, "jobTitle");
const createCrop = createCMS(CMS, "crop");
const createVariety = createCMS(CMS, "variety");
const createVendor = createCMS(CMS, "vendor");
const createItarKharchCategory = createCMS(CMS, "itarKharchCategory");

/*
  -controller function to get cms
  -it can be village, taluka, district, job title, crop, variety, vendor
*/

const getCMSData = getCMS(CMS);

const allowedCmsEntities = new Set([
  "village",
  "taluka",
  "district",
  "jobTitle",
  "crop",
  "variety",
  "vendor",
  "itarKharchCategory",
]);

const createCMSData = catchAsync(async (req, res, next) => {
  const { entity } = req.params;
  const value = String(req.body?.data || req.body?.value || "").trim();

  if (!allowedCmsEntities.has(entity)) {
    return next(new AppError("Invalid CMS entity type", 400));
  }
  if (!value) {
    return next(new AppError("CMS value is required", 400));
  }

  const existing = await CMS.findOne({
    type: entity,
    data: { $regex: `^${value}$`, $options: "i" },
  }).lean();

  if (existing) {
    return res.status(200).json(generateResponse("Success", "CMS value already exists", existing));
  }

  const created = await CMS.create({ type: entity, data: value });
  return res.status(201).json(generateResponse("Success", "CMS value created", created));
});

export {
  createVillage,
  createTaluka,
  createDistrict,
  createJobTitle,
  createCrop,
  createVariety,
  createVendor,
  createItarKharchCategory,
  getCMSData,
  createCMSData,
};
