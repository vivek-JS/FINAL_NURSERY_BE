import express from "express";
import { authorizeRoles } from "../middlewares/auth.middleware.js";
import { createBulkItarKharch, getItarKharchEntries } from "../controllers/itarKharch.controller.js";

const router = express.Router();

const allowCashierFlows = authorizeRoles(["SUPER_ADMIN", "ADMIN", "ACCOUNTANT", "CASHIER"]);

router.get("/", allowCashierFlows, getItarKharchEntries);
router.post("/bulk", allowCashierFlows, createBulkItarKharch);

export default router;
