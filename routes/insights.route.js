import express from "express";
import {
  getInsightsDashboard,
  getInsightsOperations,
} from "../controllers/insights.controller.js";
import { getCollectionsOverview } from "../controllers/collectionsInsights.controller.js";

const router = express.Router();

router.get("/dashboard", getInsightsDashboard);
router.get("/operations", getInsightsOperations);
router.get("/collections/overview", getCollectionsOverview);

export default router;
