import express from "express";
import { registerFace, registerFaceUpload } from "../controllers/faceRegistration.controller.js";
import { verifyFace, verifyFaceUpload } from "../controllers/faceVerification.controller.js";
import { getToday, getHistory } from "../controllers/attendanceHistory.controller.js";
import { getDashboard } from "../controllers/attendanceDashboard.controller.js";
import { faceOperationRateLimiter } from "../middlewares/faceAttendanceRateLimit.middleware.js";

const router = express.Router();

// Mounted with authenticateToken in app.js — every route here requires a logged-in employee.
router.post("/register-face", faceOperationRateLimiter, registerFaceUpload, registerFace);
router.post("/verify-face", faceOperationRateLimiter, verifyFaceUpload, verifyFace);
router.get("/today", getToday);
router.get("/history", getHistory);
router.get("/dashboard", getDashboard);

export default router;
