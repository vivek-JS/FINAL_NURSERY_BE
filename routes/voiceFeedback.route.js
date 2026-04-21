import express from "express";
import { authenticateToken } from "../middlewares/auth.middleware.js";
import { requireVoiceFeedbackAdmin } from "../middlewares/voiceFeedbackAuth.middleware.js";
import {
  exotelStatusWebhook,
  startCall,
  listCalls,
  getCall,
  getTranscript,
  getEvents,
  resolveCallback,
  dashboardSummary,
} from "../controllers/voiceFeedback.controller.js";

const router = express.Router();

router.post("/exotel/status", exotelStatusWebhook);

router.post("/calls/start/:id", authenticateToken, requireVoiceFeedbackAdmin, startCall);
router.get("/calls", authenticateToken, requireVoiceFeedbackAdmin, listCalls);
router.get("/calls/:id", authenticateToken, requireVoiceFeedbackAdmin, getCall);
router.get("/calls/:id/transcript", authenticateToken, requireVoiceFeedbackAdmin, getTranscript);
router.get("/calls/:id/events", authenticateToken, requireVoiceFeedbackAdmin, getEvents);
router.post("/calls/:id/resolve-callback", authenticateToken, requireVoiceFeedbackAdmin, resolveCallback);
router.get("/dashboard/summary", authenticateToken, requireVoiceFeedbackAdmin, dashboardSummary);

export default router;
