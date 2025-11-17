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

// ============================================
// PUBLIC ENDPOINTS - NO AUTHENTICATION REQUIRED
// These endpoints are completely open and can be accessed from anywhere without token
// Explicitly bypass any auth middleware that might be applied at app level
// ============================================

// Middleware to explicitly ensure no auth is checked (even if something intercepts)
const bypassAuth = (req, res, next) => {
  // Explicitly set req.user to null to prevent any auth checks
  req.user = null;
  req.token = null;
  next();
};

router.get("/config/:slug", bypassAuth, getPublicLinkConfigBySlug);
router.post("/leads", bypassAuth, createFarmerLead);

export default router;


