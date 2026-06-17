import express from "express";
import {
  bootstrapSecondaryDispatchLedgerController,
  listSecondaryDispatchLedgerController,
  summarySecondaryDispatchLedgerController,
  writeSecondaryDispatchLedgerController,
} from "../controllers/secondaryDispatchLedger.controller.js";

const router = express.Router();

/**
 * Mount suggestion:
 * app.use("/api/v1/laboutward/secondary/vehicle-dispatch", router)
 */

router.post("/ledger/bootstrap-indexes", bootstrapSecondaryDispatchLedgerController);
router.post("/:dispatchId/ledger/write", writeSecondaryDispatchLedgerController);
router.get("/ledger/lines", listSecondaryDispatchLedgerController);
router.get("/ledger/summary", summarySecondaryDispatchLedgerController);

export default router;

