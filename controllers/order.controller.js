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
  const { orderId } = req.params;  // Extract the orderId from the request parameters
  const {
    paidAmount,
    paymentStatus,
    paymentDate,
    bankName,
    receiptPhoto,
    modeOfPayment,
  } = req.body;  // Extract the payment details from the request body
console.log(req.body)
  try {
    // Find the order by its ID
    const order = await Order.findById(orderId);

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Create the payment object using the received data
    const newPayment = {
      paidAmount,
      paymentStatus,
      paymentDate,
      bankName,
      receiptPhoto,
      modeOfPayment,
    };

    // Add the new payment to the payment array of the order
    order.payment.push(newPayment);

    // Save the updated order with the new payment
    await order.save();

    // Return success response
    return res.status(200).json({
      message: "Payment added successfully",
      updatedOrder: order,
    });
  } catch (error) {
    console.error("Error adding payment:", error);
    return res.status(500).json({ message: "Server error", error });
  }
});


 const updatePaymentStatus = async (req, res) => {
  try {
    const { orderId, paymentId, paymentStatus } = req.body;
console.log(orderId)
    // Validate input
    if (!orderId || !paymentId || !paymentStatus) {
      return res.status(400).json({ message: "Order ID, Payment ID, and Payment Status are required." });
    }

    // Find the order by orderId
    const order = await Order.findById(orderId);
console.log(order)
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    // Find the payment in the order's payments array by paymentId
    const payment = order.payment.id(paymentId);
console.log(payment)
    if (!payment) {
      return res.status(404).json({ message: "Payment not found." });
    }

    // Update the payment status
    payment.paymentStatus = paymentStatus;

    // Save the order with updated payment status
    await order.save();

    return res.status(200).json({ message: "Payment status updated successfully.", order });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An error occurred while updating the payment status.", error });
  }
};


export { getCsv, createOrder, updateOrder, addNewPayment, getOrders,updatePaymentStatus };
