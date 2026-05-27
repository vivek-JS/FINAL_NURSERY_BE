import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import {
  getFleetLedger,
  getFleetLedgerByDispatchId,
} from "../controllers/fleet.controller.js";

const router = express.Router();

router.get("/ledger", getFleetLedger);
router.get(
  "/ledger/:dispatchId",
  [check("dispatchId").isMongoId().withMessage("Invalid dispatch id")],
  checkErrors,
  getFleetLedgerByDispatchId
);

export default router;
