import express from "express";
import {

} from "../controllers/plantcms.controller.js";
import { importExcelData, validateExcel, getOverflowSlots, resetOverflowSlot, fixBookingSlotFormat } from "../controllers/excel.controller.js";

const router = express.Router();

// Routes for managing plants
router.post("/validate-excel", validateExcel); // Add a new plant
router.post("/import-excel", importExcelData); // Update plant details
router.get("/overflow-slots", getOverflowSlots); // Get overflow slots information
router.post("/reset-overflow-slot", resetOverflowSlot); // Reset overflow slot capacity
router.post("/fix-booking-slot-format", fixBookingSlotFormat); // Fix bookingSlot format in orders


export default router;
