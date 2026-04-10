import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import mongoose from "mongoose";
import {
  createVehicleDriver,
  getDriversByOwner,
  getAllVehicleDrivers,
  updateVehicleDriver,
  deleteVehicleDriver,
} from "../controllers/vehicleDriver.controller.js";

const router = express.Router();

router
  .post(
    "/create",
    [
      check("ownerId")
        .notEmpty()
        .withMessage("ownerId is required")
        .custom((value) => {
          if (!mongoose.isValidObjectId(value)) {
            throw new Error("Invalid owner id");
          }
          return true;
        }),
      check("name").notEmpty().withMessage("Driver name is required"),
    ],
    checkErrors,
    createVehicleDriver
  )
  .get("/all", getAllVehicleDrivers)
  .get(
    "/by-owner/:ownerId",
    [
      check("ownerId")
        .isMongoId()
        .withMessage("Invalid owner id format"),
    ],
    checkErrors,
    getDriversByOwner
  )
  .patch(
    "/update",
    [
      check("id")
        .exists()
        .withMessage("ID is required")
        .custom((value) => {
          if (!mongoose.isValidObjectId(value)) {
            throw new Error("Invalid ID format");
          }
          return true;
        }),
      check("name")
        .optional()
        .notEmpty()
        .withMessage("Driver name cannot be empty"),
      check("ownerId")
        .optional()
        .custom((value) => {
          if (value && !mongoose.isValidObjectId(value)) {
            throw new Error("Invalid owner id");
          }
          return true;
        }),
    ],
    checkErrors,
    updateVehicleDriver
  )
  .delete(
    "/delete",
    [
      check("id")
        .exists()
        .withMessage("ID is required")
        .custom((value) => {
          if (!mongoose.isValidObjectId(value)) {
            throw new Error("Invalid ID format");
          }
          return true;
        }),
    ],
    checkErrors,
    deleteVehicleDriver
  );

export default router;
