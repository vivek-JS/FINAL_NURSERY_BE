import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { authenticateToken } from "../middlewares/auth.middleware.js";
import {
  createTask,
  getTasks,
  getTaskStats,
  getTaskById,
  updateTask,
  updateMyAssignment,
  addTaskComment,
  deleteTask,
  getPublicTasksByEmployee,
  addPublicTaskComment,
} from "../controllers/task.controller.js";

const router = express.Router();
const TASK_ID_PARAM = ":taskId([0-9a-fA-F]{24})";

router.post(
  "/",
  authenticateToken,
  [
    check("title").notEmpty().withMessage("Title is required"),
    check("dueDate").notEmpty().withMessage("Due date is required"),
    check("assignedEmployees")
      .isArray({ min: 1 })
      .withMessage("At least one employee must be assigned"),
    check("assignedEmployees.*")
      .isMongoId()
      .withMessage("Invalid employee ID format"),
    check("sourceType")
      .optional()
      .isIn(["manual", "call_assignment"])
      .withMessage("Invalid source type"),
    check("callAssignmentListId")
      .optional({ nullable: true, checkFalsy: true })
      .isMongoId()
      .withMessage("Invalid call assignment list ID format"),
  ],
  checkErrors,
  createTask
);

router.get("/", authenticateToken, getTasks);
router.get("/stats", authenticateToken, getTaskStats);

router.get(
  "/public/employee/:employeeId",
  getPublicTasksByEmployee
);

router.post(
  "/public/:taskId/comment",
  [
    check("taskId").isMongoId().withMessage("Invalid task ID format"),
    check("name").notEmpty().withMessage("Name is required"),
    check("comment").notEmpty().withMessage("Comment is required"),
    check("statusUpdate").optional().isIn(["pending", "in_progress", "completed", "cancelled"]).withMessage("Invalid status"),
  ],
  checkErrors,
  addPublicTaskComment
);

router.patch(
  `/${TASK_ID_PARAM}/my-assignment`,
  authenticateToken,
  [
    check("taskId").isMongoId().withMessage("Invalid task ID format"),
    check("status").isIn(["pending", "in_progress", "completed"]).withMessage("Invalid status"),
  ],
  checkErrors,
  updateMyAssignment
);

router.get(
  `/${TASK_ID_PARAM}`,
  authenticateToken,
  [
    check("taskId").isMongoId().withMessage("Invalid task ID format"),
  ],
  checkErrors,
  getTaskById
);

router.put(
  `/${TASK_ID_PARAM}`,
  authenticateToken,
  [
    check("taskId").isMongoId().withMessage("Invalid task ID format"),
  ],
  checkErrors,
  updateTask
);

router.post(
  `/${TASK_ID_PARAM}/comment`,
  authenticateToken,
  [
    check("taskId").isMongoId().withMessage("Invalid task ID format"),
    check("name").notEmpty().withMessage("Name is required"),
    check("comment").notEmpty().withMessage("Comment is required"),
  ],
  checkErrors,
  addTaskComment
);

router.delete(
  `/${TASK_ID_PARAM}`,
  authenticateToken,
  [
    check("taskId").isMongoId().withMessage("Invalid task ID format"),
  ],
  checkErrors,
  deleteTask
);

export default router;
