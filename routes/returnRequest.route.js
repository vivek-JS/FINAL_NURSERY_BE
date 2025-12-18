import express from "express";
import {
  getAllReturnRequests,
  getReturnRequestById,
  approveReturnRequest,
  rejectReturnRequest,
  getPendingReturnRequestsCount,
} from "../controllers/returnRequest.controller.js";
import { authenticateToken } from "../middlewares/auth.middleware.js";

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Get all return requests (with filters)
router.get("/", getAllReturnRequests);

// Get pending return requests count
router.get("/pending/count", getPendingReturnRequestsCount);

// Get return request by ID
router.get("/:id", getReturnRequestById);

// Approve return request (only ADMIN or SUPER_ADMIN)
router.patch("/:id/approve", approveReturnRequest);

// Reject return request (only ADMIN or SUPER_ADMIN)
router.patch("/:id/reject", rejectReturnRequest);

export default router;



