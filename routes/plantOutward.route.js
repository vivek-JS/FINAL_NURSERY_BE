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
  getPrimaryInwards,
  getPrimaryOutwards,
  getSecondaryInwards,
  getSecondaryOutwards,
  getPrimaryInwardById,
  getPrimaryOutwardById,
  getSecondaryInwardById,
  getSecondaryOutwardById
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

router.get("/primary-inwards", getPrimaryInwards);
router.get("/primary-outwards", getPrimaryOutwards);
router.get("/secondary-inwards", getSecondaryInwards);
router.get("/secondary-outwards", getSecondaryOutwards);

// GET routes for individual entries
router.get("/primary-inward/:batchId/:primaryInwardId", getPrimaryInwardById);
router.get("/primary-outward/:batchId/:primaryOutwardId", getPrimaryOutwardById);
router.get("/secondary-inward/:batchId/:secondaryInwardId", getSecondaryInwardById);
router.get("/secondary-outward/:batchId/:secondaryOutwardId", getSecondaryOutwardById);
export default router;
