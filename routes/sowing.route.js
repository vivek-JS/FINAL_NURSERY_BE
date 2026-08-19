import express from "express";
import {
  createSowing,
  createMultipleSowings,
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
  getPlantsGapSummary,
  getSlotOrdersSummary,
  getTodaySowingData,
  getAllPlantsTodaySowingCards,
  getEasy30DaySowingCards,
  bulkUpdatePlantReadyDaysForFutureSlots,
  getSowingInsightsRecords,
} from "../controllers/sowing.controller.js";
import {
  createSowingRequest,
  getAllSowingRequests,
  getPendingSowingRequests,
  getSowingRequestById,
  updateSowingRequest,
  issueStockFromRequest,
  rejectSowingRequest,
  cancelSowingRequest,
  cancelAllSowingRequests,
  checkRequestExists,
} from "../controllers/sowingRequest.controller.js";
import { sendSowingRemindersWhatsApp } from "../controllers/sowingWhatsApp.controller.js";
import {
  createExcessiveSowingRequest,
  getAvailablePlantsForExcessiveSowing,
  checkExcessiveSowingCard,
  getAllExcessiveSowingSlots,
  getDiagnosticInfo,
  fixExcessiveSowingData,
  checkInventoryStock,
  addTestInventoryStock,
  analyzeInventoryPurpose,
} from "../controllers/excessiveSowing.controller.js";
import {
  markRequestAsIssued,
  updateSowingProgress,
  getSowingRequestStatus,
  getActiveSowingRequests,
  recalculateSowingRemaining,
  cancelSowingRequest as cancelSowingAndRevertStock,
} from "../controllers/sowingRequestProgress.controller.js";
import {
  createRaisingIntake,
  updateRaisingIntake,
  getAvailableRaisingIntakes,
  getRaisingIntakeById,
  getRaisingIntakeByOrder,
  getPendingRaisingOrders,
  raisingUpload,
} from "../controllers/raisingSeed.controller.js";
import {
  getTodaySowingCardsLite,
  getOrderWiseSowing,
} from "../controllers/sowingCardsLite.controller.js";
import {
  optionalCompleteSowUpload,
  completeSowingRequest,
  editSowEntry,
  getIssuedSowingQueue,
  getSowingCompletions,
  getSowSlotPreview,
} from "../controllers/sowingRequestComplete.controller.js";
import { getDeliveryVsReadyAnalytics } from "../controllers/deliveryVsReady.controller.js";
import {
  listDirectSowOrders,
  submitDirectSow,
} from "../controllers/adminDirectSow.controller.js";
import {
  getOrderSlotExcess,
  completeOrderFromSlotExcess,
} from "../controllers/orderSowFromExcess.controller.js";
import {
  getSlotCoverableOrders,
  allocateSlotToOrders,
} from "../controllers/slotExcessAllocation.controller.js";
import {
  getSlotTransferTargets,
  transferSlotToSlot,
} from "../controllers/slotTransfer.controller.js";

const router = express.Router();

// Sowing CRUD routes
router.post("/", createSowing); // Create new sowing record
router.post("/multiple", createMultipleSowings); // Create multiple sowing records
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
router.get("/plants-gap-summary", getPlantsGapSummary); // Get all plants with subtype-wise totalBookingGap summary
router.get("/slot-orders/:slotId", getSlotOrdersSummary); // Get orders summary for a specific slot
router.get("/today-sowing-data", getTodaySowingData); // Get today's sowing data for all plants (due and current day)
router.get("/today-sowing-cards", getAllPlantsTodaySowingCards); // Get all plants subtype cards for today and overdue (flat structure, no accordion)
router.get("/today-sowing-cards-lite", getTodaySowingCardsLite); // Lean cards + order seed summary (fast UI)
router.get("/order-wise", getOrderWiseSowing); // Order-wise rows for Request Packets drawer
router.get("/completions", getSowingCompletions); // Completed sow history (paginated + order search)
router.get("/analytics/delivery-vs-ready", getDeliveryVsReadyAnalytics); // Delivery vs ready/available chart
router.get("/admin-direct-sow/orders", listDirectSowOrders); // Office/Super Admin: orders by delivery date
router.post("/admin-direct-sow", submitDirectSow); // Office/Super Admin: sow entry bypassing packet issue
router.get("/order/:orderId/slot-excess", getOrderSlotExcess); // Preview saleable excess on delivery slot
router.post("/order/:orderId/complete-from-excess", completeOrderFromSlotExcess); // Mark sow done from slot excess
router.get("/slot/:slotId/coverable-orders", getSlotCoverableOrders); // Slot-first: pending orders for surplus slot
router.post("/slot/:slotId/allocate-to-orders", allocateSlotToOrders); // Bulk allocate excess → orders
router.get("/slot/:slotId/transfer-targets", getSlotTransferTargets); // Slot-to-slot transfer targets
router.post("/slot/:fromSlotId/transfer-to-slot", transferSlotToSlot); // Move available plants between slots
router.get("/easy-30-days", getEasy30DaySowingCards); // Easy sowing cards for rolling day window
router.post("/easy-30-days/ready-days", bulkUpdatePlantReadyDaysForFutureSlots); // Update plant ready days for future slots only
router.get("/insights/records", getSowingInsightsRecords); // Unified sowing insights records for side drawer feed

// Sowing Request routes
router.post("/request/create", createSowingRequest); // Create sowing request from today's sowing cards
router.get("/request/check", checkRequestExists); // Check if request exists for plant/subtype
router.get("/request/all", getAllSowingRequests); // Get all sowing requests (with optional status filter)
router.get("/request/pending", getPendingSowingRequests); // Get all pending sowing requests
router.get("/request/active", getActiveSowingRequests); // Get all active sowing requests (issued/in-progress)
router.get("/request/issued-queue", getIssuedSowingQueue); // Shed-ops: issued not yet completed
router.get("/request/:requestId/slot-preview", getSowSlotPreview); // Preview target slot by sow + ready days
router.get("/request/:id", getSowingRequestById); // Get sowing request by ID
router.get("/request/:requestId/status", getSowingRequestStatus); // Get request status with progress
router.put("/request/:id", updateSowingRequest); // Update sowing request (edit)
router.post("/request/:id/issue", issueStockFromRequest); // Issue stock from sowing request (exact quantity)
router.post(
  "/request/:requestId/complete-sow",
  optionalCompleteSowUpload,
  completeSowingRequest
); // Complete sow: plants + labour + optional photos (JSON or multipart)
router.patch("/request/:requestId/sow-entry", editSowEntry); // Edit sow date/ready days; reslot by ready date
router.put("/request/:requestId/mark-issued", markRequestAsIssued); // Mark request as issued (after inventory outward)
router.put("/request/:requestId/update-progress", updateSowingProgress); // Update sowing progress
router.post("/request/:requestId/recalculate", recalculateSowingRemaining); // Recalculate sowing remaining
router.post("/request/:id/reject", rejectSowingRequest); // Reject sowing request
router.post("/request/:id/cancel", cancelSowingRequest); // Cancel sowing request (old - just marks as cancelled)
router.post("/request/:requestId/cancel-and-revert", cancelSowingAndRevertStock); // Cancel and revert all changes (slots + inventory)
router.post("/request/cancel-all", cancelAllSowingRequests); // Cancel all pending sowing requests (for testing)

// Raising (customer-given) seed intake — Phase 1 until request
router.post(
  "/raising/intake",
  raisingUpload.array("photos", 8),
  createRaisingIntake
);
router.patch(
  "/raising/intake/:id",
  raisingUpload.array("photos", 8),
  updateRaisingIntake
);
router.get("/raising/available", getAvailableRaisingIntakes);
router.get("/raising/pending-orders", getPendingRaisingOrders);
router.get("/raising/by-order/:orderId", getRaisingIntakeByOrder);
router.get("/raising/:id", getRaisingIntakeById);

// Excessive Sowing routes
router.post("/excessive/create-request", createExcessiveSowingRequest); // Create excessive sowing request (no orders)
router.get("/excessive/available-plants", getAvailablePlantsForExcessiveSowing); // Get plants available for excessive sowing
router.get("/excessive/check-card/:plantId/:subtypeId", checkExcessiveSowingCard); // Check if excessive sowing card exists
router.get("/excessive/all-slots", getAllExcessiveSowingSlots); // Get all slots with excessive sowing data
router.get("/excessive/diagnostic", getDiagnosticInfo); // Get diagnostic info for troubleshooting
router.post("/excessive/fix-data", fixExcessiveSowingData); // Fix data - enable sowing and set purposes
router.get("/excessive/check-inventory", checkInventoryStock); // Check inventory stock details
router.post("/excessive/add-test-stock", addTestInventoryStock); // Add test inventory stock (for testing)
router.get("/excessive/analyze-purpose/:productId", analyzeInventoryPurpose); // Analyze inventory purpose breakdown

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




