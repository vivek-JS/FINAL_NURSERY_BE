import express from "express";
import {
  getToday,
  getHistory,
  verifyAndMark,
  verifyAndMarkUpload,
} from "../controllers/mobileAttendance.controller.js";
import { faceOperationRateLimiter } from "../middlewares/faceAttendanceRateLimit.middleware.js";

const router = express.Router();

router.get("/today", getToday);
router.get("/history", getHistory);
router.post("/verify-and-mark", faceOperationRateLimiter, verifyAndMarkUpload, verifyAndMark);

export default router;
