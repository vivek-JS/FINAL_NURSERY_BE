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
  getPlantSubtypeTrends,
  getOrderStatusDistribution,
  getCustomerTypeDistribution,
  getRevenueTrends,
  getPlantPerformanceComparison,
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

// New Visualization Routes
router.get("/plant-subtype-trends", getPlantSubtypeTrends);
router.get("/order-status-distribution", getOrderStatusDistribution);
router.get("/customer-type-distribution", getCustomerTypeDistribution);
router.get("/revenue-trends", getRevenueTrends);
router.get("/plant-performance-comparison", getPlantPerformanceComparison);

export default router; 