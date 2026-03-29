import express from "express";
import { getCMSData, createCMSData } from "../controllers/cms.controller.js";
import { authorizeRoles } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.get("/:entity/:name?", getCMSData);
router.post("/:entity", authorizeRoles(["SUPER_ADMIN", "ADMIN", "ACCOUNTANT", "CASHIER"]), createCMSData);

export default router;
