import express from "express";
import { getInsightsDashboard } from "../controllers/insights.controller.js";

const router = express.Router();

router.get("/dashboard", getInsightsDashboard);

export default router;
