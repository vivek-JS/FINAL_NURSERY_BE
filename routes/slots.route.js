import express from "express";
import {
  addManualSlot,
  deleteManualSlot,
  getAllSlots,
  getPlantNames,
  getPlantStats,
  getSlotsByPlantAndSubtype,
  getSubtypesByPlant,
  updateSlotFieldById,
  updateSlotBuffer,
  testSlotGeneration,
  updateSlotSalesmenRestrictions,
  createSlotsForMultipleYears,
  migrateBufferCalculations,
  migrateSlotCapacityModel,
  releaseBufferPlantsController,
  addPlantsToCapacityController,
  createSlotsForSubtype,
  getSlotDetailsById,
  getSlotTrail,
  getSimpleSlots,
  getAvailabilityOverview,
  getSlotTransferOptions,
  transferSlotPlants,
  getTransferCapacityOptions,
  transferCapacity,
  getOrdersTransferTargets,
  transferOrders,
  getStockEntry,
  getLagwadAnalysisHandler,
  getSlotSecondaryShedBreakdownHandler,
  transferSlotExpectedMortalityHandler,
  bulkStockEntry,
  runPastDueSlotRolloverController,
  getRollExpiredAvailableSources,
  postRollExpiredAvailable,
  getSlotReadyRollLog,
  getSlotOrderDispatchByBatchHandler,
} from "../controllers/slots.controller.js";
import { getDashboardInsights } from "../controllers/stats.controller.js";
const slotRouter = express.Router();

// Route to get monthly slots for a specific year
slotRouter.get("/slots", getAllSlots);
slotRouter.get("/slots/get-plants", getPlantNames);
slotRouter.get("/slots/subtyps", getSubtypesByPlant);
slotRouter.get("/slots/getslots", getSlotsByPlantAndSubtype);
slotRouter.get("/slots/stock-entry", getStockEntry);
slotRouter.get("/slots/lagwad-analysis", getLagwadAnalysisHandler);
slotRouter.get(
  "/slots/:slotId/secondary-shed-breakdown",
  getSlotSecondaryShedBreakdownHandler
);
slotRouter.get("/slots/:slotId/ready-roll-log", getSlotReadyRollLog);
slotRouter.get(
  "/slots/:slotId/order-dispatch-by-batch",
  getSlotOrderDispatchByBatchHandler
);
slotRouter.post(
  "/slots/:slotId/transfer-expected-mortality",
  transferSlotExpectedMortalityHandler
);
slotRouter.put("/slots/stock-entry/bulk", bulkStockEntry);
slotRouter.get("/slots/simple", getSimpleSlots);
slotRouter.get("/slots/availability-overview", getAvailabilityOverview);
slotRouter.get("/slots/transfer-options", getSlotTransferOptions);
slotRouter.get("/slots/transfer-capacity-options", getTransferCapacityOptions);
slotRouter.get("/slots/orders-transfer-targets", getOrdersTransferTargets);
slotRouter.get("/slots/stats", getPlantStats);
slotRouter.get("/slots/dashBoardStats", getDashboardInsights);
slotRouter.get("/slots/:slotId/details", getSlotDetailsById);
slotRouter.get("/slots/:slotId/full", getSlotDetailsById); // Full DB document endpoint
slotRouter.post("/slots/manual", addManualSlot);
slotRouter.delete("/slots/manual/:slotId", deleteManualSlot);
slotRouter.post("/slots/create-multiple-years", createSlotsForMultipleYears);
slotRouter.post("/slots/create-subtype", createSlotsForSubtype);
slotRouter.post("/slots/transfer", transferSlotPlants);
slotRouter.post("/slots/transfer-capacity", transferCapacity);
slotRouter.post("/slots/transfer-orders", transferOrders);
slotRouter.post("/slots/past-due-rollover/run", runPastDueSlotRolloverController);
slotRouter.get("/slots/roll-expired-available/sources", getRollExpiredAvailableSources);
slotRouter.post("/slots/roll-expired-available", postRollExpiredAvailable);

// Salesmen restriction routes - Using completely different path pattern
slotRouter.put("/salesmen-access/:slotId", updateSlotSalesmenRestrictions);

// Buffer operations routes - MUST be before general update route
slotRouter.put("/slots/:slotId/buffer", updateSlotBuffer);
slotRouter.post("/slots/:slotId/release-buffer", releaseBufferPlantsController);
slotRouter.post("/slots/:slotId/add-capacity", addPlantsToCapacityController);

// General slot update route - MUST be after specific routes
slotRouter.put("/slots/:slotId", updateSlotFieldById);

// Migration route for buffer calculations
slotRouter.post("/slots/migrate-buffers", migrateBufferCalculations);
slotRouter.post("/slots/migrate-capacity-model", migrateSlotCapacityModel);

// Test route for slot generation
slotRouter.get("/slots/test-generation", (req, res) => {
  try {
    const testResults = testSlotGeneration();
    res.status(200).json({ 
      success: true, 
      message: "Slot generation test completed", 
      data: testResults 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: "Test failed", 
      error: error.message 
    });
  }
});

// Get slot trail history
slotRouter.get("/slot-trail/:slotId", getSlotTrail);

export default slotRouter;
