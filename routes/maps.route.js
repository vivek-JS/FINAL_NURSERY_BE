import express from "express";
import { getDirections } from "../controllers/maps.controller.js";
import { authenticateToken } from "../middlewares/auth.middleware.js";

const router = express.Router();

// Google Maps API proxy routes
// These routes proxy requests to Google Maps APIs to avoid CORS issues
router.post("/directions", authenticateToken, getDirections);

export default router;





