import express from "express";
import {
  addLabEntry,
  updateLabEntry,
  patchLabReviewStatus,
  getPlantOutwardByBatchId,
  getPrimaryMobileDashboard,
  getSecondaryMobileDashboard,
  getAcceptedLabLines,
  getAllPlantOutwards,
  addPrimaryInward,
  updatePrimaryInward,
  deletePrimaryInward,
  getPrimaryInwardByBatchId,
  labToPrimaryInward,
  primaryToSecondaryInward,
  acknowledgePrimaryOutwardForSecondary,
  recordSecondaryPrimaryOutwardMortality,
  markSecondaryPrimaryOutwardSowingComplete,
  getTransferHistory,
  primaryInwardToPrimaryOutward,
  secondaryInwardToSecondaryOutward,
  getPrimaryInwards,
  getPrimaryInwardLinesPaginated,
  getPrimaryOutwards,
  getSecondaryInwards,
  getSecondaryOutwards,
  getPrimaryInwardById,
  getPrimaryOutwardById,
  getSecondaryInwardById,
  getSecondaryOutwardById,
  getSecondaryOrdersReadyForDispatch,
  getSecondaryVehicleDispatches,
  getVehicleDispatchAllocationSuggestions,
  patchSecondaryInwardReadinessBypass,
} from "../controllers/plantOutward.controller.js";

const router = express.Router();

router.post("/batch/labs", addLabEntry);
router.patch("/batch/:batchId/lab/:labId/review", patchLabReviewStatus);
router.put("/batch/outward/lab/:batchId/:outwardId/:labId", updateLabEntry);
router.get("/batch/:batchId", getPlantOutwardByBatchId);
router.get("/primary-mobile-dashboard", getPrimaryMobileDashboard);
router.get("/secondary-mobile-dashboard", getSecondaryMobileDashboard);
router.get("/accepted-lab-lines", getAcceptedLabLines);
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
/** Namespaced aliases (same handlers) — primary vs secondary mobile flows */
router.post("/primary/lab-to-primary-inward/:batchId", labToPrimaryInward);
router.post(
  "/primary/primary-inward-to-primary-outward/:batchId",
  primaryInwardToPrimaryOutward
);
router.post("/secondary/from-primary-outward/:batchId", primaryToSecondaryInward);
router.post(
  "/secondary/acknowledge-primary-outward/:batchId/:primaryOutwardId",
  acknowledgePrimaryOutwardForSecondary
);
router.post(
  "/secondary/primary-outward/:batchId/:primaryOutwardId/mortality",
  recordSecondaryPrimaryOutwardMortality
);
router.post(
  "/secondary/primary-outward/:batchId/:primaryOutwardId/sowing-complete",
  markSecondaryPrimaryOutwardSowingComplete
);
router.post(
  "/secondary/secondary-inward-to-outward/:batchId",
  secondaryInwardToSecondaryOutward
);
router.get("/secondary/vehicle-dispatches", getSecondaryVehicleDispatches);
router.get(
  "/secondary/vehicle-dispatch/:dispatchId/allocation-suggestions",
  getVehicleDispatchAllocationSuggestions
);
router.get(
  "/secondary/:batchId/orders-ready-for-dispatch",
  getSecondaryOrdersReadyForDispatch
);
router.patch(
  "/secondary/:batchId/secondary-inward/:secondaryInwardId/readiness-bypass",
  patchSecondaryInwardReadinessBypass
);
router.get("/transfers/:batchId", getTransferHistory);

router.get("/primary-inwards", getPrimaryInwards);
router.get("/primary-inward-lines", getPrimaryInwardLinesPaginated);
router.get("/primary-outwards", getPrimaryOutwards);
router.get("/secondary-inwards", getSecondaryInwards);
router.get("/secondary-outwards", getSecondaryOutwards);

// GET routes for individual entries
router.get("/primary-inward/:batchId/:primaryInwardId", getPrimaryInwardById);
router.get("/primary-outward/:batchId/:primaryOutwardId", getPrimaryOutwardById);
router.get("/secondary-inward/:batchId/:secondaryInwardId", getSecondaryInwardById);
router.get("/secondary-outward/:batchId/:secondaryOutwardId", getSecondaryOutwardById);
export default router;
