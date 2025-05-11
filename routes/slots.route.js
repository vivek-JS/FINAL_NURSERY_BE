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
} from "../controllers/slots.controller.js";
import { getDashboardInsights } from "../controllers/stats.controller.js";
const slotRouter = express.Router();
// Route to get monthly slots for a specific year
slotRouter.get("/slots", getAllSlots);
slotRouter.get("/slots/get-plants", getPlantNames);
slotRouter.get("/slots/subtyps", getSubtypesByPlant);
slotRouter.get("/slots/getslots", getSlotsByPlantAndSubtype);
slotRouter.put("/slots/:slotId", updateSlotFieldById);
slotRouter.get("/slots/stats", getPlantStats);
slotRouter.post("/slots/manual", addManualSlot);
slotRouter.delete("/slots/manual/:slotId", deleteManualSlot);

slotRouter.get("/slots/dashBoardStats", getDashboardInsights);


export default slotRouter;
