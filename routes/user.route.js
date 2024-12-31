import express from "express";
import {
  createUser,
  updateUser,
  deleteUser,
  findUser,
  login,
  encryptPassword,
  getUsers,
} from "../controllers/user.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";

const router = express.Router();

router
  .post(
    "/login",
    [
      check("phoneNumber", "Please provide valid email").isMobilePhone(),
      check("password", "Please provide valid password").notEmpty(),
    ],
    login
  )
  .post(
    "/createUser",
    [
      check("name", "Please provide valid name").notEmpty(),
      check("phoneNumber", "Please provide valid phoneNumber").notEmpty(),
    ],
    checkErrors,
     encryptPassword,
    createUser
  )
  .patch(
    "/updateUser",
    [check("id", "Please provide valid userId").isMongoId()],
    encryptPassword,
    checkErrors,
    updateUser
  )
  .delete(
    "/deleteUser",
    [check("id", "Please provide valid userId").isMongoId()],
    checkErrors,
    deleteUser
  )
  .get(
    "/allusers",
    getUsers
  );;

export default router;
