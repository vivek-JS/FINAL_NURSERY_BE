import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import {
  createAttendance,
  updateAttendance,
  deleteAttendance,
  getAttendance,
} from "../controllers/attendance.controller.js";

const router = express.Router();

router
  .get("/getAttendance", getAttendance)
  .post(
    "/createAttendance",
    [
      check("employeeId").isMongoId().withMessage("Employee Id is required"),
      check("status")
        .notEmpty()
        .withMessage("Status of attendance is required"),
    ],
    checkErrors,
    createAttendance
  )
  .patch(
    "/updateAttendance",
    [check("id").notEmpty().withMessage("Attendance Id is required")],
    checkErrors,
    updateAttendance
  )
  .delete(
    "/deleteAttendance",
    [check("id").notEmpty().withMessage("Attendance Id is required")],
    checkErrors,
    deleteAttendance
  );

export default router;
