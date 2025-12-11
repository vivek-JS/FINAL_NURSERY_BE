import express from "express";
import {
} from "../controllers/plantcms.controller.js";
import { importExcelData, validateExcel, getOverflowSlots, resetOverflowSlot, fixBookingSlotFormat, downloadUnprocessedFile, getUnprocessedFiles, getErrorfulOrders } from "../controllers/excel.controller.js";
import { authenticateToken } from "../middlewares/auth.middleware.js";

const router = express.Router();

// Routes for managing plants
router.post("/validate-excel", authenticateToken, validateExcel); // Validate Excel file
router.post("/import-excel", authenticateToken, importExcelData); // Import Excel data
router.get("/overflow-slots", authenticateToken, getOverflowSlots); // Get overflow slots information
router.post("/reset-overflow-slot", authenticateToken, resetOverflowSlot); // Reset overflow slot capacity
router.post("/fix-booking-slot-format", authenticateToken, fixBookingSlotFormat); // Fix bookingSlot format in orders
router.get("/unprocessed-files", authenticateToken, getUnprocessedFiles); // Get list of unprocessed files
router.get("/errorful-orders", authenticateToken, getErrorfulOrders); // Get list of errorful orders (failed imports)
router.get("/download-unprocessed/:filename", downloadUnprocessedFile); // Download unprocessed rows file (no auth required for download)

export default router;
