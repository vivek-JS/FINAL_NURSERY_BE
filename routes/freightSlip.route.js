import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import {
  listTrips,
  getSlipForDispatch,
  getQuote,
  putTentative,
  postFinalize,
  getSlipPdf,
} from "../controllers/freightSlip.controller.js";
import { userCanManageTrips } from "../services/freightSlip.service.js";
import generateResponse from "../utility/responseFormat.js";

const router = express.Router();
const validDispatchId = [check("dispatchId").isMongoId().withMessage("Invalid dispatch id"), checkErrors];

router.get("/quote", getQuote);
router.get("/trips", listTrips);
router.get("/dispatch/:dispatchId", validDispatchId, getSlipForDispatch);
router.put("/dispatch/:dispatchId/tentative", validDispatchId, putTentative);
const requireTripManager = (req, res, next) => {
  if (userCanManageTrips(req.user)) return next();
  return res.status(403).json(generateResponse("error", "Insufficient permissions", null, null));
};

router.post(
  "/dispatch/:dispatchId/finalize",
  requireTripManager,
  validDispatchId,
  postFinalize
);
router.get("/dispatch/:dispatchId/pdf", validDispatchId, getSlipPdf);

export default router;
