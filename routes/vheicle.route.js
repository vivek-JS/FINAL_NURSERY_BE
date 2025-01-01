import express from "express";
import {
  createVehicle,
  getAllVehicles,
  getVehicleById,
  updateVehicle,
  deleteVehicle,
  bulkUpdateVehicles,
  getActiveVehicles
} from "../controllers/vheicle.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";

const router = express.Router();

router
  .post(
    "/create",
    [
      check("name").notEmpty().withMessage("Vehicle name is required"),
      check("number")
        .notEmpty()
        .withMessage("Vehicle number is required")
        .custom((value) => {
          // You can add custom validation for vehicle number format if needed
          if (!/^[A-Z]{2}[0-9]{2}[A-Z]{2}[0-9]{4}$/.test(value)) {
            throw new Error("Invalid vehicle number format");
          }
          return true;
        })
    ],
    checkErrors,
    createVehicle
  )
  .get("/all", getAllVehicles)
  .get("/active", getActiveVehicles)
  .patch(
    "/bulk-update",
    [
      check("vehicles")
        .isArray()
        .withMessage("vehicles should be an array")
        .notEmpty()
        .withMessage("vehicles array cannot be empty"),
      check("vehicles.*.id")
        .isMongoId()
        .withMessage("Invalid vehicle id format"),
    ],
    checkErrors,
    bulkUpdateVehicles
  )
  .get(
    "/:id",
    [
      check("id")
        .isMongoId()
        .withMessage("Invalid vehicle id format")
    ],
    checkErrors,
    getVehicleById
  )
  .patch(
    "/update/:id",
    [
      check("id")
        .isMongoId()
        .withMessage("Invalid vehicle id format"),
      check("name")
        .optional()
        .notEmpty()
        .withMessage("Vehicle name cannot be empty"),
      check("number")
        .optional()
        .notEmpty()
        .withMessage("Vehicle number cannot be empty")
        .custom((value) => {
          if (!/^[A-Z]{2}[0-9]{2}[A-Z]{2}[0-9]{4}$/.test(value)) {
            throw new Error("Invalid vehicle number format");
          }
          return true;
        }),
      check("isActive")
        .optional()
        .isBoolean()
        .withMessage("isActive must be a boolean value")
    ],
    checkErrors,
    updateVehicle
  )
  .delete(
    "/:id",
    [
      check("id")
        .isMongoId()
        .withMessage("Invalid vehicle id format")
    ],
    checkErrors,
    deleteVehicle
  );

export default router;