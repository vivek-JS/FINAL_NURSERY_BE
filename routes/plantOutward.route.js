import express from "express";
import {
 addLabEntry,
 updateLabEntry,
 getAllPlantOutwards
} from "../controllers/plantOutward.controller.js";

const router = express.Router();

router.post("/batch/labs", addLabEntry); 
router.put("/batch/outward/lab/:batchId/:outwardId/:labId", updateLabEntry);
router.get("/outwards", getAllPlantOutwards);

export default router;