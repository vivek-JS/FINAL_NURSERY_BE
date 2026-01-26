import express from "express";
import {
  getAllFarmerLists,
  getFarmerListById,
  createFarmerList,
  updateFarmerList,
  addFarmersToList,
  removeFarmersFromList,
  deleteFarmerList,
} from "../controllers/farmerList.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";

const router = express.Router();

router
  .get("/", getAllFarmerLists)
  .get("/:id", getFarmerListById)
  .post(
    "/",
    [
      check("name").notEmpty().withMessage("List name is required"),
      check("farmerIds").optional().isArray().withMessage("Farmer IDs must be an array"),
    ],
    checkErrors,
    createFarmerList
  )
  .patch(
    "/:id",
    [
      check("id").isMongoId().withMessage("Please enter valid list ID"),
      check("farmerIds").optional().isArray().withMessage("Farmer IDs must be an array"),
    ],
    checkErrors,
    updateFarmerList
  )
  .post(
    "/:id/add-farmers",
    [
      check("id").isMongoId().withMessage("Please enter valid list ID"),
      check("farmerIds")
        .isArray()
        .withMessage("Farmer IDs must be an array")
        .notEmpty()
        .withMessage("Please provide at least one farmer ID"),
    ],
    checkErrors,
    addFarmersToList
  )
  .post(
    "/:id/remove-farmers",
    [
      check("id").isMongoId().withMessage("Please enter valid list ID"),
      check("farmerIds")
        .isArray()
        .withMessage("Farmer IDs must be an array")
        .notEmpty()
        .withMessage("Please provide at least one farmer ID"),
    ],
    checkErrors,
    removeFarmersFromList
  )
  .delete(
    "/:id",
    [check("id").isMongoId().withMessage("Please enter valid list ID")],
    checkErrors,
    deleteFarmerList
  );

export default router;
