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
  deleteAllSowings,
  updateSowing,
  getSlotPlantReadyDays,
  getSowingAlerts,
  getSowingAlertsByStart,
  getTodaySowingSummary,
  getPlantReminders,
  getPlantAlerts,
  getPlantAvailability,
  getAllPlantsAvailability,
} from "../controllers/sowing.controller.js";
import { sendSowingRemindersWhatsApp } from "../controllers/sowingWhatsApp.controller.js";

const router = express.Router();

// Sowing CRUD routes
router.post("/", createSowing); // Create new sowing record
router.get("/", getSowings); // Get all sowings with filters
router.get("/stats", getSowingStats); // Get sowing statistics
router.get("/insights", (req, res) => {
  console.log("Insights route called");
  getSowingInsights(req, res);
}); // Get comprehensive sowing insights for CEO dashboard
// NEW APIs with plant selection (mandatory)
router.get("/plant-reminders", getPlantReminders); // Get plant reminders (plantId required, subtype-wise)
router.get("/plant-alerts", getPlantAlerts); // Get plant alerts (plantId required, subtype-wise)
router.get("/plant-availability", getPlantAvailability); // Get plant availability (plantId required, shows only available slots)
router.get("/all-plants-availability", getAllPlantsAvailability); // Get all plants availability (date range mandatory, shows all plants with all subtypes)

// WhatsApp integration for sowing reminders
router.post("/whatsapp/reminders", sendSowingRemindersWhatsApp); // Generate and prepare sowing reminders for WhatsApp

// OLD APIs - DEPRECATED (will be removed in future)
// router.get("/reminders", getPendingReminders); // DEPRECATED - Use /plant-reminders instead
// router.get("/alerts", getSowingAlerts); // DEPRECATED - Use /plant-alerts instead
// router.get("/sowing-alerts", getSowingAlertsByStart); // DEPRECATED - Use /plant-alerts instead
// router.get("/sowing-alerts/today", getTodaySowingSummary); // DEPRECATED
router.get("/slot-ready-days/:slotId", getSlotPlantReadyDays); // Fetch plant ready days for a slot
router.get("/:id", getSowingById); // Get single sowing by ID
router.put("/:id", updateSowing); // Update sowing record
router.delete("/:id", deleteSowing); // Delete sowing record
router.delete("/", deleteAllSowings); // Delete all sowing records

// Sowing update routes
router.post("/:id/office-sowed", updateOfficeSowed); // Update office sowed quantity
router.post("/:id/primary-sowed", updatePrimarySowed); // Update primary sowed quantity
router.post("/:id/harvest", updateHarvest); // Update harvest information

export default router;




