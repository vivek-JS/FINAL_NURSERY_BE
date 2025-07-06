import express from "express";
import { getCMSData } from "../controllers/cms.controller.js";

const router = express.Router();

router.get("/:entity/:name?", getCMSData);

export default router;
