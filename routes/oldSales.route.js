import express from "express";
import {
  getOldSalesAnalytics,
  getOldSalesFilters,
  getOldSalesSuggestions,
  normalizeOldSalesField,
  getOldSalesChangeLogs,
  getOldSalesCaseMismatches,
  normalizeOldSalesCase,
  getOldSalesRepeatCustomers,
  getOldSalesGeoSummary,
  getOldSalesRecords,
  exportOldSalesCsv,
} from "../controllers/oldSalesAnalytics.controller.js";

const router = express.Router();

router.get("/filters", getOldSalesFilters);
router.get("/analytics", getOldSalesAnalytics);
router.get("/suggestions", getOldSalesSuggestions);
router.get("/case-mismatches", getOldSalesCaseMismatches);
router.get("/repeat-customers", getOldSalesRepeatCustomers);
router.get("/geo-summary", getOldSalesGeoSummary);
router.get("/records", getOldSalesRecords);
router.patch("/normalize", normalizeOldSalesField);
router.patch("/normalize-case", normalizeOldSalesCase);
router.get("/changes", getOldSalesChangeLogs);
router.get("/export", exportOldSalesCsv);

export default router;
