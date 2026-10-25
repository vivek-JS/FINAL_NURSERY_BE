import express from "express";
import { authenticateToken, authorizeRoles } from "../middlewares/auth.middleware.js";
import {
  attendanceBoard,
  clockIn,
  clockOut,
  punchLocation,
  todayAttendance,
} from "../controllers/fieldAttendance.controller.js";

const router = express.Router();
router.use(authenticateToken);
router.get("/today", todayAttendance);
router.get(
  "/board",
  authorizeRoles(["SUPER_ADMIN", "SUPERADMIN", "ADMIN"]),
  attendanceBoard
);
router.post("/clock-in", clockIn);
router.post("/clock-out", clockOut);
router.post("/punch", punchLocation);

export default router;
