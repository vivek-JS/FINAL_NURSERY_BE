import express from "express";
import {
  createVehicle,
  getAllVehicles,
  getVehicleById,
  updateVehicle,
  deleteVehicle,
  bulkUpdateVehicles,
  getActiveVehicles,
} from "../controllers/vheicle.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import mongoose from "mongoose";

const router = express.Router();

router
  .post(
    "/create",
    [
      check("name").notEmpty().withMessage("Vehicle name is required"),
      check("number").notEmpty().withMessage("Vehicle number is required"),
      check("capacity")
        .notEmpty()
        .withMessage("Vehicle capacity is required")
        .isNumeric()
        .withMessage("Capacity must be a number")
        .custom((value) => {
          if (parseFloat(value) <= 0) {
            throw new Error("Capacity must be greater than 0");
          }
          return true;
        }),
      check("ownerId")
        .optional({ values: "null" })
        .custom((value) => {
          if (value == null || value === "") return true;
          if (!mongoose.isValidObjectId(value)) {
            throw new Error("Invalid owner id");
          }
          return true;
        }),
      check("defaultDriverId")
        .optional({ values: "null" })
        .custom((value) => {
          if (value == null || value === "") return true;
          if (!mongoose.isValidObjectId(value)) {
            throw new Error("Invalid default driver id");
          }
          return true;
        }),
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
  .patch(
    "/update",
    [
      check("id")
        .exists()
        .withMessage("ID is required")
        .custom((value) => {
          if (!mongoose.isValidObjectId(value)) {
            throw new Error("Invalid vehicle id format");
          }
          return true;
        }),
      check("name")
        .optional()
        .notEmpty()
        .withMessage("Vehicle name cannot be empty"),
      check("number")
        .optional()
        .notEmpty()
        .withMessage("Vehicle number cannot be empty"),
      check("capacity")
        .optional()
        .isNumeric()
        .withMessage("Capacity must be a number")
        .custom((value) => {
          if (parseFloat(value) <= 0) {
            throw new Error("Capacity must be greater than 0");
          }
          return true;
        }),
      check("isActive")
        .optional()
        .isBoolean()
        .withMessage("isActive must be a boolean value"),
      check("ownerId")
        .optional({ values: "null" })
        .custom((value) => {
          if (value == null || value === "") return true;
          if (!mongoose.isValidObjectId(value)) {
            throw new Error("Invalid owner id");
          }
          return true;
        }),
      check("defaultDriverId")
        .optional({ values: "null" })
        .custom((value) => {
          if (value == null || value === "") return true;
          if (!mongoose.isValidObjectId(value)) {
            throw new Error("Invalid default driver id");
          }
          return true;
        }),
    ],
    checkErrors,
    updateVehicle
  )
  .delete(
    "/delete",
    [
      check("id")
        .exists()
        .withMessage("ID is required")
        .custom((value) => {
          if (!mongoose.isValidObjectId(value)) {
            throw new Error("Invalid vehicle id format");
          }
          return true;
        }),
    ],
    checkErrors,
    deleteVehicle
  )
  .get(
    "/:id",
    [check("id").isMongoId().withMessage("Invalid vehicle id format")],
    checkErrors,
    getVehicleById
  )
  .patch(
    "/update/:id",
    [
      check("id").isMongoId().withMessage("Invalid vehicle id format"),
      check("name")
        .optional()
        .notEmpty()
        .withMessage("Vehicle name cannot be empty"),
      check("number")
        .optional()
        .notEmpty()
        .withMessage("Vehicle number cannot be empty"),
      check("capacity")
        .optional()
        .isNumeric()
        .withMessage("Capacity must be a number")
        .custom((value) => {
          if (parseFloat(value) <= 0) {
            throw new Error("Capacity must be greater than 0");
          }
          return true;
        }),
      check("isActive")
        .optional()
        .isBoolean()
        .withMessage("isActive must be a boolean value"),
    ],
    checkErrors,
    updateVehicle
  )
  .delete(
    "/:id",
    [check("id").isMongoId().withMessage("Invalid vehicle id format")],
    checkErrors,
    deleteVehicle
  );

export default router;
