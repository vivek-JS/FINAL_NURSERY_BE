import { Parser as CsvParser } from "json2csv";
import catchAsync from "../utility/catchAsync.js";
import Order from "../models/order.model.js";
import {
  getAll,
  createOne,
  updateOne,
  updateOneAndPushElement,
} from "./factory.controller.js";
import generateResponse from "../utility/responseFormat.js";

const getCsv = catchAsync(async (req, res, next) => {
  // extracting data
  const { startDate, endDate } = req.query;

  let jsonData = await Order.find({
    createdAt: {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    },
  }).populate("farmer");

  // if data not found
  if (!jsonData || jsonData.length === 0) {
    return next(new AppError("Data not found", 404));
  }
  // preparing data
  let srNo = 0;
  let csvData = [];
  let csvFields = [
    "Sr",
    "Farmer name",
    "Mobile number",
    "Mode of payment",
    "Total amount",
    "Advance",
    "Number of plants",
    "Type of plants",
  ];
  await Promise.all(
    jsonData.map(async (obj) => {
      csvData.push({
        Sr: srNo + 1,
        "Farmer name": obj.farmer.name,
        "Mobile number": obj.farmer.mobileNumber,
        "Mode of payment": obj?.modeOfPayment,
        "Total amount": obj?.rate,
        Advance: obj?.advance,
        "Number of plants": obj?.numberOfPlants,
        "Type of plants": obj?.typeOfPlants,
      });
    })
  );

  // seding response
  const csvParse = new CsvParser({ fields: csvFields });
  const csvDataParsed = csvParse.parse(csvData);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=payments.csv");
  res.status(200).end(csvDataParsed);
});

const getOrders = getAll(Order, "Order");
const createOrder = createOne(Order, "Order");
const updateOrder = updateOne(Order, "Order");
const addNewPayment = catchAsync(async (req, res, next) => {
  const { id, paymentAmount, receiptPhoto } = req.body;

  const updateObj = {};
  if (!updateObj.$push) updateObj.$push = {};

  if (paymentAmount !== undefined) {
    updateObj.$push.payment = { paidAmount: paymentAmount };
  }
  if (receiptPhoto !== undefined) {
    updateObj.$push.receiptPhoto = receiptPhoto;
  }

  const doc = await Order.findByIdAndUpdate(id, updateObj, {
    new: true,
    runValidators: true,
  });

  if (!doc) {
    return next(new AppError(`No order found with that ID`, 404));
  }

  const response = generateResponse(
    "Success",
    `order updated successfully`,
    doc,
    undefined
  );

  return res.status(200).json(response);
});

export { getCsv, createOrder, updateOrder, addNewPayment, getOrders };
