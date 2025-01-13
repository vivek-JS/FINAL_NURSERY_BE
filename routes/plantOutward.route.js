import express from "express";
import {
  addLabEntry,
  updateLabEntry,
  getAllPlantOutwards,
  addPrimaryInward,
  updatePrimaryInward,
  deletePrimaryInward,
  getPrimaryInwardByBatchId,
} from "../controllers/plantOutward.controller.js";

const router = express.Router();

router.post("/batch/labs", addLabEntry);
router.put("/batch/outward/lab/:batchId/:outwardId/:labId", updateLabEntry);
router.get("/outwards", getAllPlantOutwards);
router.post("/plant-outward/primary-inward", addPrimaryInward);
router.patch(
  "/plant-outward/primary-inward/:batchId/:primaryInwardId",
  updatePrimaryInward
);
router.delete(
  "/plant-outward/:batchId/primary-inward/:primaryInwardId",
  deletePrimaryInward
);
router.get("/plant-outward/primary-inward/:batchId", getPrimaryInwardByBatchId);
export default router;
