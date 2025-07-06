import express from "express";
import {

} from "../controllers/plantcms.controller.js";
import { importExcelData, validateExcel,  } from "../controllers/excel.controller.js";

const router = express.Router();

// Routes for managing plants
router.post("/validate-excel", validateExcel); // Add a new plant
router.post("/import-excel", importExcelData); // Update plant details


export default router;
