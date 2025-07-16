import express from "express";
import {
  getAllStates,
  getStates,
  createState,
  updateState,
  deleteState,
  getDistrictsByState,
  getTalukasByStateAndDistrict,
  getVillagesByStateDistrictAndTaluka,
  addDistrictToState,
  addTalukaToDistrict,
  addVillageToTaluka,
  getLocationHierarchy,
} from "../controllers/state.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";

const router = express.Router();

// Get all states (basic info)
router.get("/all", getAllStates);

// Get all states (full details)
router.get("/", getStates);

// Get districts by state
router.get("/:stateId/districts", getDistrictsByState);

// Get talukas by state and district
router.get("/:stateId/districts/:districtId/talukas", getTalukasByStateAndDistrict);

// Get villages by state, district, and taluka
router.get("/:stateId/districts/:districtId/talukas/:talukaId/villages", getVillagesByStateDistrictAndTaluka);

// Get complete location hierarchy
router.get("/:stateId/districts/:districtId/talukas/:talukaId/villages/:villageId", getLocationHierarchy);

// Create new state
router.post(
  "/",
  [
    check("name").notEmpty().withMessage("State name is required"),
    check("code").notEmpty().withMessage("State code is required"),
  ],
  checkErrors,
  createState
);

// Add district to state
router.post(
  "/:stateId/districts",
  [
    check("name").notEmpty().withMessage("District name is required"),
    check("code").notEmpty().withMessage("District code is required"),
  ],
  checkErrors,
  addDistrictToState
);

// Add taluka to district
router.post(
  "/:stateId/districts/:districtId/talukas",
  [
    check("name").notEmpty().withMessage("Taluka name is required"),
    check("code").notEmpty().withMessage("Taluka code is required"),
  ],
  checkErrors,
  addTalukaToDistrict
);

// Add village to taluka
router.post(
  "/:stateId/districts/:districtId/talukas/:talukaId/villages",
  [
    check("name").notEmpty().withMessage("Village name is required"),
    check("code").notEmpty().withMessage("Village code is required"),
  ],
  checkErrors,
  addVillageToTaluka
);

// Update state
router.patch("/:id", updateState);

// Delete state
router.delete("/:id", deleteState);

export default router; 