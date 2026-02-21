import express from "express";
import { authenticateToken } from "../middlewares/auth.middleware.js";
import { getEmployeeMetrics } from "../controllers/followupMetrics.controller.js";

const router = express.Router();

router.get("/metrics", authenticateToken, getEmployeeMetrics);

export default router;

