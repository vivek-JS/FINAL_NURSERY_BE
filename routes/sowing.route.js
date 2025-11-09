import express from "express";
import {
  createSowing,
  getSowings,
  getSowingById,
  updateOfficeSowed,
  updatePrimarySowed,
  updateHarvest,
  getPendingReminders,
  getSowingStats,
  getSowingInsights,
  deleteSowing,
  updateSowing,
  getSlotPlantReadyDays,
  getSowingAlerts,
  getSowingAlertsByStart,
  getTodaySowingSummary,
} from "../controllers/sowing.controller.js";

const router = express.Router();

// Sowing CRUD routes
router.post("/", createSowing); // Create new sowing record
router.get("/", getSowings); // Get all sowings with filters
router.get("/stats", getSowingStats); // Get sowing statistics
router.get("/insights", (req, res) => {
  console.log("Insights route called");
  getSowingInsights(req, res);
}); // Get comprehensive sowing insights for CEO dashboard
router.get("/reminders", getPendingReminders); // Get pending reminders
router.get("/alerts", getSowingAlerts); // Comprehensive sowing alerts
router.get("/sowing-alerts", getSowingAlertsByStart); // Sowing alerts using slot start date logic
router.get("/sowing-alerts/today", getTodaySowingSummary); // Plant-subtype summary for overdue + due today
router.get("/slot-ready-days/:slotId", getSlotPlantReadyDays); // Fetch plant ready days for a slot
router.get("/:id", getSowingById); // Get single sowing by ID
router.put("/:id", updateSowing); // Update sowing record
router.delete("/:id", deleteSowing); // Delete sowing record

// Sowing update routes
router.post("/:id/office-sowed", updateOfficeSowed); // Update office sowed quantity
router.post("/:id/primary-sowed", updatePrimarySowed); // Update primary sowed quantity
router.post("/:id/harvest", updateHarvest); // Update harvest information

export default router;




