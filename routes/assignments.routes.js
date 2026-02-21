import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { authenticateToken } from "../middlewares/auth.middleware.js";
import { rateLimitPublic } from "../middlewares/rateLimit.middleware.js";
import { createAssignment, listAssignments, updateAssignment } from "../controllers/assignments.controller.js";

const router = express.Router();

router.post(
  "/",
  rateLimitPublic,
  authenticateToken,
  [
    check("phone").optional().isString().withMessage("phone must be a string"),
    check("farmerId").optional().isMongoId().withMessage("Invalid farmerId"),
    check("scheduledAt").optional().isISO8601().withMessage("Invalid scheduledAt"),
  ],
  checkErrors,
  createAssignment
);

router.get("/", authenticateToken, listAssignments);

router.patch(
  "/:id",
  authenticateToken,
  [
    check("id").isMongoId().withMessage("Invalid id"),
    check("status").optional().isIn(["pending", "completed", "canceled"]).withMessage("Invalid status"),
    check("scheduledAt").optional().isISO8601().withMessage("Invalid scheduledAt"),
  ],
  checkErrors,
  updateAssignment
);

export default router;

