import express from "express";
import { markLinkedAgriLoadedViaLink } from "../controllers/agriSalesOrder.controller.js";

const router = express.Router();

router.get("/mark-loaded", markLinkedAgriLoadedViaLink);

export default router;
