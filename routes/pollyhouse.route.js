import express from "express";
import { check } from "express-validator";
import mongoose from "mongoose";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import {
  createPollyHouse,
  getAllPollyHouses,
  updatePollyHouse,
  togglePollyHouseStatus
} from "../controllers/pollyhouse.controller.js";

const router = express.Router();

const validateObjectId = (value) => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new Error("Invalid ID format");
  }
  return true;
};

router
  .post(
    "/create",
    [
      check("name").notEmpty().withMessage("PollyHouse name is required"),

    ],
    checkErrors,
    createPollyHouse
  )
  .get("/all", getAllPollyHouses)
  .patch(
    "/update",
    [
      check("id")
        .exists().withMessage("ID is required")
        .custom(validateObjectId),
      check("name")
        .optional()
        .notEmpty().withMessage("Name cannot be empty"),
     
    ],
    checkErrors,
    updatePollyHouse
  )
  .patch(
    "/toggle-status",
    [
      check("id")
        .exists().withMessage("ID is required")
        .custom(validateObjectId),
      check("isActive")
        .isBoolean().withMessage("isActive must be a boolean value")
    ],
    checkErrors,
    togglePollyHouseStatus
  );

export default router;