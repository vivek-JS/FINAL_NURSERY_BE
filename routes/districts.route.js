import express from "express";
import {
  getAllStates,
  getDistrictsByState,
  getSubDistrictsByStateAndDistrict,
  getVillagesByStateDistrictAndSubDistrict,
} from "../controllers/districts.controller.js";

const router = express.Router();

router.get("/districts", getDistrictsByState);
router.get("/subdistricts", getSubDistrictsByStateAndDistrict);
router.get("/getVillages", getVillagesByStateDistrictAndSubDistrict);
router.get("/states", getAllStates);

export default router;
