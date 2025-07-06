import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import {
  createEmployee,
  deleteEmployee,
  updateEmployee,
  getEmployee,
  getEmployees,
} from "../controllers/employee.controller.js";
import { createJobTitle } from "../controllers/cms.controller.js";

const router = express.Router();

router
  .get("/getEmployees", getEmployees)
  .get("/getEmployee", getEmployee)
  .post(
    "/createEmployee",
    [
      check("name").notEmpty().withMessage("Name of employee is required"),
      check("phoneNumber")
        .notEmpty()
        .withMessage("Phone number of employee is required"),
      check("jobTitle")
        .notEmpty()
        .withMessage("Job title of employee is required"),
      check("email")
        .isEmail()
        .withMessage("Email address of employee is required"),
    ],
    checkErrors,
    createJobTitle,
    createEmployee
  )
  .patch(
    "/updateEmployee",
    [check("id").notEmpty().withMessage("Employee Id is required")],
    checkErrors,
    updateEmployee
  )
  .delete(
    "/deleteEmployee",
    [check("id").notEmpty().withMessage("Employee Id is required")],
    checkErrors,
    deleteEmployee
  );

export default router;
