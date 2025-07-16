import express from "express";
import {
  getDashboardAnalytics,
  getProfitLossAnalysis,
  getSalesPerformanceAnalysis,
  getPlantPerformanceAnalysis,
  getCustomerAnalytics,
  getMonthlyTrends,
  getDistrictAnalytics,
  getSlotAnalytics,
  getEnhancedCustomerAnalytics,
  getPaymentAnalytics,
} from "../controllers/analytics.controller.js";

const router = express.Router();

// Analytics Routes
router.get("/dashboard", getDashboardAnalytics);
router.get("/profit-loss", getProfitLossAnalysis);
router.get("/sales-performance", getSalesPerformanceAnalysis);
router.get("/plant-performance", getPlantPerformanceAnalysis);
router.get("/customer-analytics", getCustomerAnalytics);
router.get("/monthly-trends", getMonthlyTrends);

// New Enhanced Analytics Routes
router.get("/district-analytics", getDistrictAnalytics);
router.get("/slot-analytics", getSlotAnalytics);
router.get("/enhanced-customer-analytics", getEnhancedCustomerAnalytics);
router.get("/payment-analytics", getPaymentAnalytics);

export default router; 