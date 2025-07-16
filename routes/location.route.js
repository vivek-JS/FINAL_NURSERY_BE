import express from "express";
import {
  getAllStates,
  getStatesOnly,
  getState,
  getDistricts,
  getTalukas,
  getVillages,
  getCascadingLocation,
  searchLocations,
  getLocationHierarchy,
  getAllLocationData,
  getLocationStats,
  clearLocationCache,
  preloadLocationCache
} from "../controllers/location.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";

const router = express.Router();

// Get all location data in unified format
router.get("/all", getAllLocationData);

// Get location statistics
router.get("/stats", getLocationStats);

// Clear location cache (admin only)
router.delete("/cache", clearLocationCache);

// Preload location cache (admin only)
router.post("/cache/preload", preloadLocationCache);

// Get all states (optimized for frontend)
router.get("/states-only", getStatesOnly);

// Get all states (legacy endpoint)
router.get("/states", getAllStates);

// Get state by name or ID
router.get("/states/:stateIdentifier", getState);

// Get districts for a state (by name or ID)
router.get("/states/:stateIdentifier/districts", getDistricts);

// Get talukas for a district (by name or ID)
router.get("/states/:stateIdentifier/districts/:districtIdentifier/talukas", getTalukas);

// Get villages for a taluka (by name or ID)
router.get("/states/:stateIdentifier/districts/:districtIdentifier/talukas/:talukaIdentifier/villages", getVillages);

// Flexible cascading location API - accepts names or IDs in request body
router.post("/cascade", [
  check("state").notEmpty().withMessage("State identifier is required"),
  check("district").optional(),
  check("taluka").optional(),
], checkErrors, getCascadingLocation);

// Search locations by name (fuzzy search)
router.get("/search", [
  check("query").notEmpty().withMessage("Search query is required"),
  check("type").optional().isIn(['all', 'states', 'districts', 'talukas', 'villages']).withMessage("Invalid type parameter"),
], checkErrors, searchLocations);

// Get complete location hierarchy by IDs
router.get("/hierarchy/:stateId/districts/:districtId/talukas/:talukaId/villages/:villageId", getLocationHierarchy);

export default router; 