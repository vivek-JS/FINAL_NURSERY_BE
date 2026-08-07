import express from "express";
import { requireEmployeeManager } from "../middlewares/employeeRole.middleware.js";
import {
  listEmployeesWithFaceStatus,
  getAttendanceLogs,
  exportAttendanceLogsCsv,
  listDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
} from "../controllers/adminAttendance.controller.js";

const router = express.Router();

// Mounted with authenticateToken in app.js. Every route here is additionally
// gated to Office Admin / Super Admin (mirrors employee.route.js conventions).
router.use(requireEmployeeManager);

router.get("/employees", listEmployeesWithFaceStatus);
router.get("/logs", getAttendanceLogs);
router.get("/logs/export.csv", exportAttendanceLogsCsv);

router.get("/departments", listDepartments);
router.post("/departments", createDepartment);
router.patch("/departments/:id", updateDepartment);
router.delete("/departments/:id", deleteDepartment);

export default router;
