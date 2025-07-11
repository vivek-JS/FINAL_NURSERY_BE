import express from "express";
import {
  createOrUpdatePricing,
  getAllPricing,
  getPricingByPlant,
  getPricingByPlantSubtype,
  deletePricing,
  getPricingAnalytics,
  getPlantsWithoutPricing,
  bulkUpdatePricing,
} from "../controllers/pricing.controller.js";
import { authenticateToken } from "../middlewares/auth.middleware.js";

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// CRUD Operations
router.post("/", createOrUpdatePricing);
router.get("/", getAllPricing);
router.get("/plant/:plantId", getPricingByPlant);
router.get("/plant/:plantId/subtype/:subtypeId", getPricingByPlantSubtype);
router.delete("/:id", deletePricing);

// Analytics Routes
router.get("/analytics", getPricingAnalytics);
router.get("/missing", getPlantsWithoutPricing);

// Bulk Operations
router.post("/bulk", bulkUpdatePricing);

export default router; 