import express from "express";
import {
  sendMsg,
  fetchTemplates,
  getBroadcastList,
  getBroadcastLists,
  createBroadcastList,
  deleteBroadcastList,
  getContactsToCreateBroadcastList,
} from "../controllers/msg.controller.js";
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
    sendMsg
  )
  .get("/getTemplates", fetchTemplates)
  .get("/getBroadcastList", getBroadcastList)
  .get("/getBroadcastLists", getBroadcastLists)
  .post("/createBroadcastList", createBroadcastList)
  .delete("/deleteBroadcastList", deleteBroadcastList);

export default router;
