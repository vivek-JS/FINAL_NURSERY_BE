import generateResponse from "../utility/responseFormat.js";
import catchAsync from "../utility/catchAsync.js";
import Farmer from "../models/farmer.model.js";
import Employee from "../models/employee.model.js";
import User from "../models/user.model.js";
import BroadcastGroup from "../models/broadcast.model.js";
import fetch from "node-fetch";
import { createOne, getOne, getAll, deleteOne } from "./factory.controller.js";

const sendMsg = catchAsync(async (req, res, next) => {
  const { mobileNumbers, templateName } = req.body;
  const WATI_URL = process.env.SEND_TEMPLATE_MESSAGE_URL;

  mobileNumbers.map(async (mobileNumber) => {
    const farmer = await Farmer.findOne({ mobileNumber });

    const body = {
      template_name: `${templateName}`,
      broadcast_name: "ss",
      parameters: [
        {
          name: "name",
          value: `${farmer.name}`,
        },
      ],
    };

    const response = await fetch(
      `${WATI_URL}?whatsappNumber=91${mobileNumber}`,
      {
        method: "post",
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          Authorization: process.env.WATI_TOKEN,
        },
      }
    );

    // const data = response;

    // console.log(data)
  });

  const response = generateResponse(
    "Success",
    "Messages sent successfully",
    undefined,
    undefined
  );

  return res.status(200).json(response);
});

const fetchTemplates = catchAsync(async (req, res, next) => {
  const WATI_URL = process.env.WATI_URL;

  const watiResponse = await fetch(`${WATI_URL}/api/v1/getMessageTemplates`, {
    method: "get",
    headers: {
      "Content-Type": "application/json",
      Authorization: process.env.WATI_TOKEN,
    },
  });

  const data = await watiResponse.json();

  const response = generateResponse(
    "Success",
    "Templates fetched successfully",
    data.messageTemplates,
    undefined
  );

  return res.status(200).json(response);
});

const getContactsToCreateBroadcastList = catchAsync(async (req, res, next) => {
  const [farmerData, employeeData, userData] = await Promise.all([
    Farmer.find().select("name mobileNumber"),
    Employee.find().select("name phoneNumber"),
    User.find().select("name phoneNumber jobTitle"),
  ]);

  const response = generateResponse(
    "Success",
    "Messages sent successfully",
    {
      farmers: farmerData.map((farmer) => ({
        name: farmer.name,
        phoneNumber: farmer.mobileNumber,
      })),
      employees: employeeData.map((employee) => ({
        name: employee.name,
        phoneNumber: employee.phoneNumber,
      })),
      users: userData.map((user) => ({
        name: user.name,
        phoneNumber: user.phoneNumber,
        jobTitle: user.jobTitle,
      })),
    },
    undefined
  );

  return res.status(200).json(response);
});

const getBroadcastList = getOne(BroadcastGroup, "BroadcastGroup");
const getBroadcastLists = getAll(BroadcastGroup, "BroadcastGroup");
const createBroadcastList = createOne(BroadcastGroup, "BroadcastGroup");
const deleteBroadcastList = deleteOne(BroadcastGroup, "BroadcastGroup");

// TODO: make a controller to send message to broadcast that we have created

export {
  sendMsg,
  fetchTemplates,
  getContactsToCreateBroadcastList,
  getBroadcastList,
  getBroadcastLists,
  createBroadcastList,
  deleteBroadcastList,
};
