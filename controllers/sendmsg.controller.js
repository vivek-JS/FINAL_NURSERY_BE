import generateResponse from "../utility/responseFormat.js";
import catchAsync from "../utility/catchAsync.js";
import Farmer from "../models/farmer.model.js";
import fetch from "node-fetch";

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

export { sendMsg };
