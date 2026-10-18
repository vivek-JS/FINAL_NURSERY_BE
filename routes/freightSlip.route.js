import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { authorizeRoles } from "../middlewares/auth.middleware.js";
import {
  listTrips,
  getSlipForDispatch,
  getQuote,
  putTentative,
  postFinalize,
  getSlipPdf,
} from "../controllers/freightSlip.controller.js";
import { FREIGHT_FINALIZE_ROLES } from "../services/freightSlip.service.js";

const router = express.Router();
const validDispatchId = [check("dispatchId").isMongoId().withMessage("Invalid dispatch id"), checkErrors];

router.get("/quote", getQuote);
router.get("/trips", listTrips);
router.get("/dispatch/:dispatchId", validDispatchId, getSlipForDispatch);
router.put("/dispatch/:dispatchId/tentative", validDispatchId, putTentative);
router.post(
  "/dispatch/:dispatchId/finalize",
  authorizeRoles(FREIGHT_FINALIZE_ROLES),
  validDispatchId,
  postFinalize
);
router.get("/dispatch/:dispatchId/pdf", validDispatchId, getSlipPdf);

export default router;
