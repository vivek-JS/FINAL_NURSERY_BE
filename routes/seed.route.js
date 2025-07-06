import {
  createSeedInward,
  updateSeedInward,
  deleteSeedInward,
  getSeedInward,
  createSeedOutward,
  updateSeedOutward,
  deleteSeedOutward,
  getSeedOutward,
} from "../controllers/seed.controller.js";
import express from "express";
import {
  createCrop,
  createVariety,
  createVendor,
} from "../controllers/cms.controller.js";

const seedRouter = express.Router();

seedRouter
  .get("/getSeedInward", getSeedInward)
  .post(
    "/createSeedInward",
    createCrop,
    createVariety,
    createVendor,
    createSeedInward
  )
  .patch("/updateSeedInward", updateSeedInward)
  .delete("/deleteSeedInward", deleteSeedInward)
  .get("/getSeedOutward", getSeedOutward)
  .post(
    "/createSeedOutward",
    createCrop,
    createVariety,
    createVendor,
    createSeedOutward
  )
  .patch("/updateSeedOutward", updateSeedOutward)
  .delete("/deleteSeedOutward", deleteSeedOutward);

export default seedRouter;
