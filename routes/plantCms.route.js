import express from "express";
import {
  addPlant,
  updatePlant,
  deletePlant,
  addSubtype,
  updateSubtype,
  deleteSubtype,
  getPlants,
} from "../controllers/plantcms.controller.js";

const router = express.Router();

// Routes for managing plants
router.post("/plants", addPlant); // Add a new plant
router.put("/plants/:plantId", updatePlant); // Update plant details
router.delete("/plants/:plantId", deletePlant); // Delete a plant
router.get("/plants", getPlants);

// Routes for managing subtypes of a specific plant
router.post("/plants/:plantId/subtypes", addSubtype); // Add a subtype to a plant
router.put("/plants/:plantId/subtypes/:subtypeId", updateSubtype); // Update a specific subtype
router.delete("/plants/:plantId/subtypes/:subtypeId", deleteSubtype); // Delete a specific subtype

export default router;
