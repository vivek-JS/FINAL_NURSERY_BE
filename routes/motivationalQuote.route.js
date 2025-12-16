import express from "express";
import {
  getTodaysQuote,
  seedQuotes,
  getAllQuotes,
} from "../controllers/motivationalQuote.controller.js";
import { authenticateToken } from "../middlewares/auth.middleware.js";

const router = express.Router();

// Public route - get today's quote
router.get("/today", getTodaysQuote);

// Protected routes - admin only
router.post("/seed", authenticateToken, seedQuotes);
router.get("/all", authenticateToken, getAllQuotes);

export default router;

