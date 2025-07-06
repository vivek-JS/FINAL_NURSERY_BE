import { getCMS, createCMS } from "../controllers/factory.controller.js";
import CMS from "../models/cms.model.js";

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

/*
  -controller function to get cms
  -it can be village, taluka, district, job title, crop, variety, vendor
*/

const getCMSData = getCMS(CMS);

export {
  createVillage,
  createTaluka,
  createDistrict,
  createJobTitle,
  createCrop,
  createVariety,
  createVendor,
  getCMSData,
};
