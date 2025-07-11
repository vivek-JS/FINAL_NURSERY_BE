import express from "express";
import {
  getDashboardAnalytics,
  getProfitLossAnalysis,
  getSalesPerformanceAnalysis,
  getPlantPerformanceAnalysis,
  getCustomerAnalytics,
  getMonthlyTrends,
} from "../controllers/analytics.controller.js";
import { authenticateToken } from "../middlewares/auth.middleware.js";

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Analytics Routes
router.get("/dashboard", getDashboardAnalytics);
router.get("/profit-loss", getProfitLossAnalysis);
router.get("/sales-performance", getSalesPerformanceAnalysis);
router.get("/plant-performance", getPlantPerformanceAnalysis);
router.get("/customer-analytics", getCustomerAnalytics);
router.get("/monthly-trends", getMonthlyTrends);

export default router; 