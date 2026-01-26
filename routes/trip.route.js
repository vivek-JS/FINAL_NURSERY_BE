import express from "express";
import {
  createTrip,
  getAllTrips,
  getTripById,
  getTripsByVehicle,
  updateTrip,
  deleteTrip,
} from "../controllers/trip.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";

const router = express.Router();

router
  .post(
    "/create",
    [
      check("vehicleId")
        .notEmpty()
        .withMessage("Vehicle ID is required")
        .isMongoId()
        .withMessage("Invalid vehicle ID format"),
      check("driverName")
        .notEmpty()
        .withMessage("Driver name is required"),
      check("startDate")
        .optional()
        .isISO8601()
        .withMessage("Invalid date format"),
    ],
    checkErrors,
    createTrip
  )
  .get("/all", getAllTrips)
  .get(
    "/vehicle/:vehicleId",
    [
      check("vehicleId")
        .isMongoId()
        .withMessage("Invalid vehicle ID format"),
    ],
    checkErrors,
    getTripsByVehicle
  )
  .get(
    "/:id",
    [check("id").isMongoId().withMessage("Invalid trip ID format")],
    checkErrors,
    getTripById
  )
  .patch(
    "/update/:id",
    [
      check("id").isMongoId().withMessage("Invalid trip ID format"),
      check("vehicleId")
        .optional()
        .isMongoId()
        .withMessage("Invalid vehicle ID format"),
      check("status")
        .optional()
        .isIn(["pending", "in_transit", "delivered", "cancelled"])
        .withMessage("Invalid status"),
      check("startDate")
        .optional()
        .isISO8601()
        .withMessage("Invalid date format"),
      check("endDate")
        .optional()
        .isISO8601()
        .withMessage("Invalid date format"),
    ],
    checkErrors,
    updateTrip
  )
  .delete(
    "/:id",
    [check("id").isMongoId().withMessage("Invalid trip ID format")],
    checkErrors,
    deleteTrip
  );

export default router;



