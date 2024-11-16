import express from "express";
import { getAllDistricts, getSubDistrictsByDistrict, getVillages } from "../controllers/districts.controller.js";

const router = express.Router();

router.get("/districts", getAllDistricts);
router.get("/subdistricts", getSubDistrictsByDistrict);
router.get("/getVillages", getVillages);

export default router;
