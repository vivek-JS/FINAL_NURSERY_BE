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
  testSlotGeneration,
  updateSlotSalesmenRestrictions,
} from "../controllers/slots.controller.js";
import { getDashboardInsights } from "../controllers/stats.controller.js";
const slotRouter = express.Router();
// Route to get monthly slots for a specific year
slotRouter.get("/slots", getAllSlots);
slotRouter.get("/slots/get-plants", getPlantNames);
slotRouter.get("/slots/subtyps", getSubtypesByPlant);
slotRouter.get("/slots/getslots", getSlotsByPlantAndSubtype);
slotRouter.get("/slots/stats", getPlantStats);
slotRouter.post("/slots/manual", addManualSlot);
slotRouter.delete("/slots/manual/:slotId", deleteManualSlot);

// Salesmen restriction routes - Using completely different path pattern
slotRouter.put("/salesmen-access/:slotId", updateSlotSalesmenRestrictions);

// General slot update route - MUST be after specific routes
slotRouter.put("/slots/:slotId", updateSlotFieldById);

slotRouter.get("/slots/dashBoardStats", getDashboardInsights);

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

export default slotRouter;
