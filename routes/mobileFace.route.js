import express from "express";
import { registerFace, registerFaceUpload, getFaceProfile } from "../controllers/mobileFace.controller.js";
import { faceOperationRateLimiter } from "../middlewares/faceAttendanceRateLimit.middleware.js";

const router = express.Router();

router.post("/register", faceOperationRateLimiter, registerFaceUpload, registerFace);
router.get("/profile", getFaceProfile);

export default router;
