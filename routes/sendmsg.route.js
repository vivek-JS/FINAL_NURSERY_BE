import express from "express";
import { sendMsg } from "../controllers/sendmsg.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";

const router = express.Router();

router
  .post(
    "/sendmsg",
    [
      check("mobileNumbers", "Please provide list of mobile number").isArray(),
      check("templateName", "Please provide valid templateName").notEmpty(),
    ],
    checkErrors,
    sendMsg,
  );

export default router;
