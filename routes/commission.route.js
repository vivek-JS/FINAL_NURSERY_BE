import express from "express";
import {
  authenticateToken,
  requireCommissionAccess,
  requireDealerAnalysisAccess,
} from "../middlewares/auth.middleware.js";
import {
  getCommissionRates,
  patchCommissionRate,
  postSyncCommissionRates,
  postBulkDefaultCommissionRates,
  getDealerCommissionAnalysis,
  getDealerCommissionSettlements,
  postSettleDealerCommission,
} from "../controllers/commission.controller.js";

const router = express.Router();

router.use(authenticateToken);

router.get(
  "/dealers/:dealerId/analysis",
  requireDealerAnalysisAccess,
  getDealerCommissionAnalysis
);

router.use(requireCommissionAccess);

router.get("/rates", getCommissionRates);
router.patch("/rates/:id", patchCommissionRate);
router.post("/rates/sync-from-plants", postSyncCommissionRates);
router.post("/rates/bulk-default", postBulkDefaultCommissionRates);

router.get("/dealers/:dealerId/settlements", getDealerCommissionSettlements);
router.post("/dealers/:dealerId/settle", postSettleDealerCommission);

export default router;
