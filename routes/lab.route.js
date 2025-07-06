import {
  createLab,
  updateLab,
  deleteLab,
} from "../controllers/lab.controller.js";
import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";

const labRouter = express.Router();

labRouter
  .post(
    "/createLab",
    [
      check("batchNumber").notEmpty().withMessage("Batch number is required"),
      check("startingDate").isDate().withMessage("Staring date is required"),
    ],
    checkErrors,
    createLab
  )
  .patch(
    "/updateLab",
    [check("id").notEmpty().withMessage("Id is required")],
    checkErrors,
    updateLab
  )
  .patch(
    "/inoculation",
    [
      check("id").notEmpty().withMessage("Id is required"),
      check("inoculation.nameOfOperator")
        .notEmpty()
        .withMessage("Name of operator is required"),
      check("inoculation.in").isNumeric().withMessage("In number is required"),
    ],
    checkErrors,
    updateLab
  )
  .patch(
    "/contamination",
    [
      check("id").notEmpty().withMessage("Id is required"),
      check("contamination.numberOfBottles")
        .isNumeric()
        .withMessage("Number of bottles is required"),
      check("contamination.in")
        .isNumeric()
        .withMessage("In number is required"),
    ],
    checkErrors,
    updateLab
  )
  .patch(
    "/mediaRoom",
    [
      check("id").notEmpty().withMessage("Id is required"),
      check("mediaRoom.numberOfBottles")
        .isNumeric()
        .withMessage("Number of bottles is required"),
      check("mediaRoom.numberOfLitersCreated")
        .isNumeric()
        .withMessage("Number of liters created is required"),
      check("mediaRoom.numberOfEmployeeEngaged")
        .isNumeric()
        .withMessage("Number of employee engaged is required"),
      check("mediaRoom.in").isNumeric().withMessage("In number is required"),
    ],
    checkErrors,
    updateLab
  )
  .patch(
    "/washing",
    [
      check("id").notEmpty().withMessage("Id is required"),
      check("washing.numberOfBottles")
        .isNumeric()
        .withMessage("Number of bottles is required"),
      check("washing.numberOfEmployeeEngaged")
        .isNumeric()
        .withMessage("Number of employee engaged is required"),
      check("washing.in").isNumeric().withMessage("In number is required"),
    ],
    checkErrors,
    updateLab
  )
  .patch(
    "/plate",
    [
      check("id").notEmpty().withMessage("Id is required"),
      check("plate.numberOfPlates")
        .isNumeric()
        .withMessage("Number of plates is required"),
      check("plate.numberOfEmployeeEngaged")
        .isNumeric()
        .withMessage("Number of employee engaged is required"),
      check("plate.in").isNumeric().withMessage("In number is required"),
    ],
    checkErrors,
    updateLab
  )
  .patch(
    "/growthRoom",
    [
      check("id").notEmpty().withMessage("Id is required"),
      check("growthRoom.numberOfEmployeeEngaged")
        .isNumeric()
        .withMessage("Number of employee engaged is required"),
      check("growthRoom.in").isNumeric().withMessage("In number is required"),
    ],
    checkErrors,
    updateLab
  )
  .patch(
    "/shooting",
    [
      check("id").notEmpty().withMessage("Id is required"),
      check("shooting.in").isNumeric().withMessage("In number is required"),
    ],
    checkErrors,
    updateLab
  )
  .patch(
    "/rootingOut",
    [
      check("id").notEmpty().withMessage("Id is required"),
      check("rootingOut.numberOfTrays")
        .isNumeric()
        .withMessage("Number of trays is required"),
      check("rootingOut.numberOfBottles")
        .isNumeric()
        .withMessage("Number of bottles is required"),
      check("rootingOut.in").isNumeric().withMessage("In number is required"),
    ],
    checkErrors,
    updateLab
  )
  .delete(
    "/deleteLab",
    [check("id").notEmpty().withMessage("Id is required")],
    checkErrors,
    deleteLab
  );

export default labRouter;
