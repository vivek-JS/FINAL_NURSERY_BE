import express from "express";
import { listBroadcasts, getBroadcastById } from "../controllers/whatsappBroadcast.controller.js";
import { authenticateToken } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.get("/", authenticateToken, listBroadcasts);
router.get("/:id", authenticateToken, getBroadcastById);

export default router;

