import express from "express";
import { requireEmployeeManager, requireSuperAdmin } from "../middlewares/employeeRole.middleware.js";
import {
  listDailyAttendance,
  getDailyAttendanceById,
  patchDailyAttendance,
  listAttendanceAttempts,
  exportDailyAttendanceCsv,
  branchAttendanceSummary,
  lateEarlyReport,
  deleteEmployeeFaceProfile,
  deleteEmployeeDevice,
  listFaceRegistrationStatus,
  listBranchLocations,
  upsertBranchLocation,
  deleteBranchLocation,
  getTodayDashboard,
} from "../controllers/mobileAttendanceAdmin.controller.js";
import {
  listOfficeGroups,
  createOfficeGroup,
  patchOfficeGroup,
  deleteOfficeGroup,
} from "../controllers/officeGroupAdmin.controller.js";
import {
  kioskIdentify,
  kioskVerifyAndMarkHandler,
  kioskRegisterFace,
  kioskMarkUpload,
  kioskRegisterUpload,
} from "../controllers/attendanceKiosk.controller.js";

const router = express.Router();
router.use(requireEmployeeManager);

router.post("/kiosk/identify", kioskMarkUpload, kioskIdentify);
router.post("/kiosk/verify-and-mark", kioskMarkUpload, kioskVerifyAndMarkHandler);
router.post("/kiosk/register-face", requireSuperAdmin, kioskRegisterUpload, kioskRegisterFace);

router.get("/today-dashboard", getTodayDashboard);
router.get("/office-groups", listOfficeGroups);
router.post("/office-groups", createOfficeGroup);
router.patch("/office-groups/:id", patchOfficeGroup);
router.delete("/office-groups/:id", deleteOfficeGroup);

router.get("/", listDailyAttendance);
router.get("/export.csv", exportDailyAttendanceCsv);
router.get("/attempts", listAttendanceAttempts);
router.get("/summary/branch", branchAttendanceSummary);
router.get("/reports/late-early", lateEarlyReport);
router.get("/face-registration-status", requireSuperAdmin, listFaceRegistrationStatus);

router.get("/branch-locations", listBranchLocations);
router.post("/branch-locations", upsertBranchLocation);
router.delete("/branch-locations/:id", deleteBranchLocation);

router.delete("/employees/:employeeId/face-profile", deleteEmployeeFaceProfile);
router.delete("/employees/:employeeId/device", deleteEmployeeDevice);

router.get("/:attendanceId", getDailyAttendanceById);
router.patch("/:attendanceId", patchDailyAttendance);

export default router;
