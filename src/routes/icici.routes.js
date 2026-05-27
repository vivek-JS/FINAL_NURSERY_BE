import express from "express";
import catchAsync from "../../utility/catchAsync.js";
import { requirePaymentAccess } from "../../middlewares/auth.middleware.js";
import {
  getHealth,
  registerWithIcici,
  fetchAccountStatement,
} from "../services/iciciApiService.js";

const router = express.Router();

/**
 * GET /api/icici/health
 * Verify certificate loading (no secrets returned).
 */
router.get("/health", requirePaymentAccess, (req, res) => {
  try {
    const data = getHealth();
    const httpStatus = data.status === "ok" ? 200 : 503;
    return res.status(httpStatus).json({ success: data.status === "ok", data });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
      code: err.code,
    });
  }
});

/**
 * POST /api/icici/register
 * Register your public.crt with ICICI Corporate API.
 */
router.post(
  "/register",
  requirePaymentAccess,
  catchAsync(async (req, res) => {
    try {
      const data = await registerWithIcici();
      return res.status(200).json({ success: true, data });
    } catch (err) {
      return res.status(err.code === "ICICI_CONFIG" ? 400 : 502).json({
        success: false,
        message: err.message,
        code: err.code,
      });
    }
  })
);

/**
 * POST /api/icici/statement
 * Body: { fromDate, toDate } — ISO or YYYY-MM-DD
 */
router.post(
  "/statement",
  requirePaymentAccess,
  catchAsync(async (req, res) => {
    const { fromDate, toDate } = req.body || {};
    if (!fromDate || !toDate) {
      return res.status(400).json({
        success: false,
        message: "fromDate and toDate are required",
      });
    }

    try {
      const data = await fetchAccountStatement(fromDate, toDate);
      return res.status(200).json({ success: true, data });
    } catch (err) {
      const status =
        err.code === "VALIDATION" ? 400 : err.code === "ICICI_CONFIG" ? 400 : 502;
      return res.status(status).json({
        success: false,
        message: err.message,
        code: err.code,
      });
    }
  })
);

export default router;
