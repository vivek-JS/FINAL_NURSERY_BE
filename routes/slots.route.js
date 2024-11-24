import express from "express";
import { getAllSlots, getPlantNames, getSlotsByPlantAndSubtype, getSubtypesByPlant, updateSlotFieldById } from "../controllers/slots.controller.js";
const slotRouter = express.Router();
// Route to get monthly slots for a specific year
slotRouter.get("/slots", getAllSlots);
slotRouter.get("/slots/get-plants", getPlantNames);
slotRouter.get("/slots/subtyps", getSubtypesByPlant);
slotRouter.get("/slots/getslots", getSlotsByPlantAndSubtype);
slotRouter.put("/slots/:slotId", updateSlotFieldById);





export default slotRouter;
