import express from "express";
import {
  sendCustomNotificationToUser,
  sendBulkNotification,
  sendNotificationByPhone,
} from "../controllers/notification.controller.js";
import { authenticateToken } from "../middlewares/auth.middleware.js";

const router = express.Router();

// All notification routes require authentication
router.use(authenticateToken);

/**
 * Send custom notification to a single user by userId
 * POST /api/v1/notifications/send-custom
 * Body: { userId, title, message, data }
 */
router.post("/send-custom", sendCustomNotificationToUser);

/**
 * Send notification to multiple users
 * POST /api/v1/notifications/send-bulk
 * Body: { userIds: ["id1", "id2"], title, message, data }
 */
router.post("/send-bulk", sendBulkNotification);

/**
 * Send notification by phone number (easiest for web UI)
 * POST /api/v1/notifications/send-by-phone
 * Body: { phoneNumber, title, message, data }
 */
router.post("/send-by-phone", sendNotificationByPhone);

export default router;

