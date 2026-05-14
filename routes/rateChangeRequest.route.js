import express from "express";
import {
  getRateChangeRequests,
  getRequestByToken,
  approveViaUI,
  rejectViaUI,
  approveViaToken,
} from "../controllers/rateChangeRequest.controller.js";
import { authorizeRoles } from "../middlewares/auth.middleware.js";

const router = express.Router();

/**
 * GET /api/v1/rate-change-requests
 * List all requests — SUPER_ADMIN only.
 */
router.get("/", authorizeRoles(["SUPER_ADMIN"]), getRateChangeRequests);

/**
 * GET /api/v1/rate-change-requests/by-token/:token
 * Public — used by the approval page to load request details before approving.
 * No role restriction; the token itself is the credential.
 */
router.get("/by-token/:token", getRequestByToken);

/**
 * POST /api/v1/rate-change-requests/approve-via-link
 * Public (no JWT) — approve via WhatsApp link. Body: { token, phone }
 * Backend verifies phone is a SUPER_ADMIN.
 */
router.post("/approve-via-link", approveViaToken);

/**
 * PATCH /api/v1/rate-change-requests/:id/approve
 * JWT-authenticated SUPER_ADMIN approve via UI.
 */
router.patch("/:id/approve", authorizeRoles(["SUPER_ADMIN"]), approveViaUI);

/**
 * PATCH /api/v1/rate-change-requests/:id/reject
 * JWT-authenticated SUPER_ADMIN reject via UI.
 */
router.patch("/:id/reject", authorizeRoles(["SUPER_ADMIN"]), rejectViaUI);

export default router;
