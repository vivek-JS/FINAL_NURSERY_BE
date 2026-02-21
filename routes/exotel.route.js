import express from "express";
import { authenticateToken } from "../middlewares/auth.middleware.js";
import { sendSms, testConnection } from "../controllers/exotel.controller.js";

const router = express.Router();

router.use(authenticateToken);

router.get("/test", testConnection);
router.post("/send", sendSms);

export default router;
