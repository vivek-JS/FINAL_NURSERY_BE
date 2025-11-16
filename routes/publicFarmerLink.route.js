import express from "express";
import { authenticateToken, requireOfficeAdmin } from "../middlewares/auth.middleware.js";
import {
  createPublicFarmerLink,
  getPublicFarmerLinks,
  getPublicFarmerLinkById,
  updatePublicFarmerLink,
  getPublicLinkConfigBySlug,
  createFarmerLead,
  getFarmerLeadsForLink
} from "../controllers/publicFarmerLink.controller.js";

const router = express.Router();

// Admin-only routes for creating and managing public farmer links
router.post(
  "/links",
  authenticateToken,
  requireOfficeAdmin,
  createPublicFarmerLink
);

router.get(
  "/links",
  authenticateToken,
  requireOfficeAdmin,
  getPublicFarmerLinks
);

router.get(
  "/links/:id",
  authenticateToken,
  requireOfficeAdmin,
  getPublicFarmerLinkById
);

router.patch(
  "/links/:id",
  authenticateToken,
  requireOfficeAdmin,
  updatePublicFarmerLink
);

router.get(
  "/links/leads/:id",
  authenticateToken,
  requireOfficeAdmin,
  getFarmerLeadsForLink
);

// Public endpoints for data entry
router.get("/config/:slug", getPublicLinkConfigBySlug);
router.post("/leads", createFarmerLead);

export default router;


