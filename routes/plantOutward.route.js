import express from "express";
import {
  addLabEntry,
  updateLabEntry,
  getAllPlantOutwards,
  addPrimaryInward,
  updatePrimaryInward,
  deletePrimaryInward,
  getPrimaryInwardByBatchId,
  labToPrimaryInward,
  primaryToSecondaryInward,
  getTransferHistory,
  primaryInwardToPrimaryOutward,
  secondaryInwardToSecondaryOutward,
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
router.post("/lab-to-primaryInward/:batchId", labToPrimaryInward);
router.post(
  "/primaryInward-to-primaryOutward/:batchId",
  primaryInwardToPrimaryOutward
);
router.post("/primary-to-secondary/:batchId", primaryToSecondaryInward);
router.post(
  "/secondaryInward-to-secondaryOutward/:batchId",
  secondaryInwardToSecondaryOutward
);
router.get("/transfers/:batchId", getTransferHistory);
export default router;
