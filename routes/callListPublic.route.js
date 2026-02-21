import express from "express";
import { getListForMobilePublic, addCallLogPublic } from "../controllers/callAssignment.controller.js";

const router = express.Router();

router.get("/:id/:token", getListForMobilePublic);
router.post("/:id/:token/call-log", addCallLogPublic);

export default router;
