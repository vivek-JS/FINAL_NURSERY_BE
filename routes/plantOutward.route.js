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
  primaryInwardFifoPreview,
  primaryInwardFifoPreviewGlobal,
  labToPrimaryInwardBulk,
  labToPrimaryInwardBulkGlobal,
  primaryToSecondaryInward,
  secondaryBatchLagwadFromPrimaryOutward,
  acknowledgePrimaryOutwardForSecondary,
  recordSecondaryPrimaryOutwardMortality,
  markSecondaryPrimaryOutwardSowingComplete,
  getTransferHistory,
  getShedActivityByBatch,
  getSecondaryInwardActivity,
  primaryInwardToPrimaryOutward,
  primaryBatchInwardToPrimaryOutward,
  patchPrimaryInwardReadinessBypass,
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
  getSowReadyEntries,
  getSecondaryPolyhouseStock,
  getFarmerDispatchPickupBatchSuggestions,
  patchSecondaryInwardReadinessBypass,
  previewSecondaryVehicleLoadHandler,
  postSecondaryVehicleLoad,
  getSecondaryVehicleLoadedLines,
  postSecondaryVehicleUnload,
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
router.post("/primary-inward-fifo-preview", primaryInwardFifoPreviewGlobal);
router.post("/primary-inward-bulk", labToPrimaryInwardBulkGlobal);
router.post("/primary-inward-fifo-preview/:batchId", primaryInwardFifoPreview);
router.post("/lab-to-primaryInward-bulk/:batchId", labToPrimaryInwardBulk);
router.post(
  "/primaryInward-to-primaryOutward/:batchId",
  primaryInwardToPrimaryOutward
);
router.post(
  "/primary-inward-to-primary-outward-batch/:batchId",
  primaryBatchInwardToPrimaryOutward
);
router.patch(
  "/primary-inward/:batchId/:primaryInwardId/readiness-bypass",
  patchPrimaryInwardReadinessBypass
);
router.post("/primary-to-secondary/:batchId", primaryToSecondaryInward);
router.post(
  "/secondaryInward-to-secondaryOutward/:batchId",
  secondaryInwardToSecondaryOutward
);
/** Namespaced aliases (same handlers) — primary vs secondary mobile flows */
router.post("/primary/lab-to-primary-inward/:batchId", labToPrimaryInward);
router.post("/primary/primary-inward-fifo-preview", primaryInwardFifoPreviewGlobal);
router.post("/primary/primary-inward-bulk", labToPrimaryInwardBulkGlobal);
router.post("/primary/primary-inward-fifo-preview/:batchId", primaryInwardFifoPreview);
router.post("/primary/lab-to-primary-inward-bulk/:batchId", labToPrimaryInwardBulk);
router.post(
  "/primary/primary-inward-to-primary-outward/:batchId",
  primaryInwardToPrimaryOutward
);
router.post(
  "/primary/:batchId/primary-inward-to-primary-outward-batch",
  primaryBatchInwardToPrimaryOutward
);
router.patch(
  "/primary/:batchId/primary-inward/:primaryInwardId/readiness-bypass",
  patchPrimaryInwardReadinessBypass
);
router.post("/secondary/from-primary-outward/:batchId", primaryToSecondaryInward);
router.post(
  "/secondary/:batchId/batch-lagwad",
  secondaryBatchLagwadFromPrimaryOutward
);
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
  "/secondary/vehicle-dispatch/:dispatchId/sow-ready-entries",
  getSowReadyEntries
);
router.get("/secondary/sow-ready-entries", getSowReadyEntries);
router.post(
  "/secondary/vehicle-dispatch/:dispatchId/load-preview",
  previewSecondaryVehicleLoadHandler
);
router.post(
  "/secondary/vehicle-dispatch/:dispatchId/load",
  postSecondaryVehicleLoad
);
router.get(
  "/secondary/vehicle-dispatch/:dispatchId/loaded-lines",
  getSecondaryVehicleLoadedLines
);
router.post(
  "/secondary/vehicle-dispatch/:dispatchId/unload",
  postSecondaryVehicleUnload
);
router.get("/secondary/polyhouse-stock", getSecondaryPolyhouseStock);
router.get(
  "/secondary/farmer-dispatch/pickup-batch-suggestions",
  getFarmerDispatchPickupBatchSuggestions
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
router.get("/activity/:batchId", getShedActivityByBatch);
router.get(
  "/secondary-inward/:batchId/:secondaryInwardId/activity",
  getSecondaryInwardActivity
);

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
