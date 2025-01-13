import express from "express";
import {
  createUser,
  updateUser,
  deleteUser,
  findUser,
  login,
  encryptPassword,
  getUsers,
  resetPassword,
  aboutMe,
} from "../controllers/user.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import verifyToken from "../middlewares/verifyToken.middleware.js";

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
  .use(verifyToken)
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
  .get("/allusers", getUsers)
  .post(
    "/resetPassword",
    resetPassword
  )
  .get(
    "/aboutMe",
    aboutMe
  );

export default router;
