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
  getDailyStats,
  getShortReport,
  getShortReportByPlant,
  getShortReportOrderDetail,
  getShortReportPayments,
  getTodayYesterdayVarietyReport,
  getDispatchDailyPulse,
  getLciSnapshot,
} from "../controllers/analytics.controller.js";

const router = express.Router();

// Analytics Routes
router.get("/dashboard", getDashboardAnalytics);
router.get("/daily-stats", getDailyStats);
router.get("/today-yesterday-variety", getTodayYesterdayVarietyReport);
router.get("/dispatch-daily-pulse", getDispatchDailyPulse);
router.get("/lci", getLciSnapshot);
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

// Static `/short-report/payments` before `/short-report/order/:orderId` so "payments" is never captured as an order id.
router.get("/short-report/payments", getShortReportPayments);
router.get("/short-report/plant/:plantId", getShortReportByPlant);
router.get("/short-report/order/:orderId", getShortReportOrderDetail);
router.get("/short-report", getShortReport);

export default router; 