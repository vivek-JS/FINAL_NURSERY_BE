import express from "express";
import { getInsightsDashboard } from "../controllers/insights.controller.js";
import { getCollectionsOverview } from "../controllers/collectionsInsights.controller.js";
import { requireInsightsAccess } from "../utils/insightsAccess.js";

const router = express.Router();

router.use(requireInsightsAccess);

router.get("/dashboard", getInsightsDashboard);
router.get("/collections/overview", getCollectionsOverview);

export default router;
