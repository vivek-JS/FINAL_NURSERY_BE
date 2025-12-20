import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { authenticateToken } from "../middlewares/auth.middleware.js";
import {
  createTask,
  getTasks,
  getTaskById,
  updateTask,
  addTaskComment,
  deleteTask,
  getPublicTasksByEmployee,
  addPublicTaskComment,
} from "../controllers/task.controller.js";

const router = express.Router();

// Create task (assign to multiple employees)
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
  ],
  checkErrors,
  createTask
);

// Get all tasks (with optional filters)
router.get("/", authenticateToken, getTasks);

// Get task by ID
router.get("/:taskId", authenticateToken, getTaskById);

// Update task
router.put(
  "/:taskId",
  authenticateToken,
  [
    check("taskId").isMongoId().withMessage("Invalid task ID format"),
  ],
  checkErrors,
  updateTask
);

// Add comment to task
router.post(
  "/:taskId/comment",
  authenticateToken,
  [
    check("taskId").isMongoId().withMessage("Invalid task ID format"),
    check("name").notEmpty().withMessage("Name is required"),
    check("comment").notEmpty().withMessage("Comment is required"),
  ],
  checkErrors,
  addTaskComment
);

// Delete task
router.delete(
  "/:taskId",
  authenticateToken,
  [
    check("taskId").isMongoId().withMessage("Invalid task ID format"),
  ],
  checkErrors,
  deleteTask
);

// Public routes (no authentication required)
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

export default router;


