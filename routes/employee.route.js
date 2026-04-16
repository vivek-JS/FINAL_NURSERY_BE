import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import {
  requireEmployeeManager,
  requireSuperAdminForEmployeeDelete,
} from "../middlewares/employeeRole.middleware.js";
import {
  createEmployee,
  deleteEmployee,
  updateEmployee,
  getEmployee,
  getEmployees,
  requireEmployeePasswordChange,
} from "../controllers/employee.controller.js";
import { createJobTitle } from "../controllers/cms.controller.js";

const router = express.Router();

// Custom middleware to handle both id and _id fields
const validateEmployeeId = (req, res, next) => {
  const { id, _id } = req.body;
  
  // If _id is provided but id is not, map _id to id
  if (_id && !id) {
    req.body.id = _id;
    delete req.body._id;
  }
  
  // Check if id exists after mapping
  if (!req.body.id) {
    return res.status(400).json({
      status: "fail",
      message: "Employee Id is required"
    });
  }
  
  next();
};

router
  .get("/getEmployees", getEmployees)
  .get("/getEmployee", getEmployee)
  .post(
    "/createEmployee",
    requireEmployeeManager,
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
    requireEmployeeManager,
    validateEmployeeId,
    updateEmployee
  )
  .patch(
    "/requirePasswordChange",
    requireEmployeeManager,
    validateEmployeeId,
    requireEmployeePasswordChange
  )
  .delete(
    "/deleteEmployee",
    requireSuperAdminForEmployeeDelete,
    [check("id").notEmpty().withMessage("Employee Id is required")],
    checkErrors,
    deleteEmployee
  );

export default router;
