import express from "express";
import { authenticateToken } from "../middlewares/auth.middleware.js";
import {
  getMessageTemplates,
  testConnection,
  sendTemplateMessage,
  sendTemplateMessages,
  getContacts,
  getMessageDetails,
  sendTextMessage,
} from "../controllers/watiProxy.controller.js";

const router = express.Router();

router.use(authenticateToken);

router.get("/templates", getMessageTemplates);
router.get("/test", testConnection);
router.get("/contacts", getContacts);
router.get("/message/:phone/:localMessageId", getMessageDetails);
router.post("/send-template", sendTemplateMessage);
router.post("/send-template-messages", sendTemplateMessages);
router.post("/send-message", sendTextMessage);

export default router;
