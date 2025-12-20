import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { authenticateToken } from "../middlewares/auth.middleware.js";
import {
  createFollowUp,
  getFollowUps,
  getAllFollowUps,
  updateFollowUp,
  deleteFollowUp,
  getPublicFollowUp,
  addPublicComment,
} from "../controllers/followUp.controller.js";

const router = express.Router();

router.post(
  "/employees/:employeeId/follow-ups",
  authenticateToken,
  [
    check("title").notEmpty().withMessage("Title is required"),
    check("followUpDate").notEmpty().withMessage("Follow-up date is required"),
    check("priority").optional().isIn(["low", "medium", "high", "urgent"]).withMessage("Invalid priority"),
  ],
  checkErrors,
  createFollowUp
);

router.get(
  "/employees/:employeeId/follow-ups",
  authenticateToken,
  getFollowUps
);

router.get(
  "/employees/follow-ups/all",
  authenticateToken,
  getAllFollowUps
);

router.put(
  "/employees/:employeeId/follow-ups/:followUpId",
  authenticateToken,
  [
    check("status").optional().isIn(["pending", "completed", "incomplete", "not_done"]).withMessage("Invalid status"),
    check("priority").optional().isIn(["low", "medium", "high", "urgent"]).withMessage("Invalid priority"),
  ],
  checkErrors,
  updateFollowUp
);

router.delete(
  "/employees/:employeeId/follow-ups/:followUpId",
  authenticateToken,
  [
    check("employeeId").isMongoId().withMessage("Invalid employee ID format"),
    check("followUpId").isMongoId().withMessage("Invalid follow-up ID format"),
  ],
  checkErrors,
  deleteFollowUp
);

router.get(
  "/public/follow-up/:token",
  getPublicFollowUp
);

router.post(
  "/public/follow-up/:token/comment",
  [
    check("name").notEmpty().withMessage("Name is required"),
    check("comment").notEmpty().withMessage("Comment is required"),
    check("statusUpdate").optional().isIn(["pending", "completed", "incomplete", "not_done"]).withMessage("Invalid status"),
  ],
  checkErrors,
  addPublicComment
);

export default router;



