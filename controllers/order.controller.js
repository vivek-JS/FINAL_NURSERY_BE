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

const getOrdersBySlot = catchAsync(async (req, res, next) => {
  const { slotId } = req.params; // Extract the slotId from the request parameters

  try {
    // Find all orders related to the given slotId
    const orders = await Order.find({ bookingSlot: slotId })
      .populate("farmer", "name mobileNumber village taluka district") // Populate farmer details
      .populate("salesPerson", "name phoneNumber")  // Populate salesperson details
      .populate("plantName", "name")                // Populate plant name
      .populate("plantSubtype", "name")             // Populate plant subtype
      .populate("bookingSlot")                      // Populate the booking slot
      .exec();

    if (!orders || orders.length === 0) {
      return res.status(404).json({ message: "No orders found for the specified slot." });
    }

    // Send all the order details along with populated references as a response
    return res.status(200).json({
      message: "Orders fetched successfully.",
      orders: orders.map((order) => {
        return {
          id: order._id,  // Returning the order ID
          _id: order._id,  // The same as the `id` field in your sample
          farmer: {
            _id: order.farmer?._id,
            name: order.farmer?.name,
            village: order.farmer?.village,
            taluka: order.farmer?.taluka,
            district: order.farmer?.district,
            mobileNumber: order.farmer?.mobileNumber
          },
          salesPerson: {
            _id: order.salesPerson?._id,
            name: order.salesPerson?.name,
            phoneNumber: order.salesPerson?.phoneNumber
          },
          numberOfPlants: order?.numberOfPlants,
          plantName: order?.plantName?.name,
          plantSubtype: order?.plantSubtype?.name,
          bookingSlot: {
            _id: order?.bookingSlot?._id,
            startDay: order?.bookingSlot?.startDay,
            endDay: order?.bookingSlot?.endDay,
            totalPlants: order?.bookingSlot?.totalPlants,
            totalBookedPlants: order?.bookingSlot?.totalBookedPlants,
            orders: order?.bookingSlot?.orders,
            overflow: order?.bookingSlot?.overflow,
            status: order?.bookingSlot?.status,
            month: order?.bookingSlot?.month
          },
          rate: order?.rate,
          orderPaymentStatus: order?.orderPaymentStatus,
          orderStatus: order?.orderStatus,
          payment: order?.payment,
          createdAt: order?.createdAt,
          updatedAt: order?.updatedAt,
          salesPersonName: order.salesPerson?.name,  // salesPersonName
          salesPersonPhoneNumber: order.salesPerson?.phoneNumber  // salesPersonPhoneNumber
        };
      }),
    });
  } catch (error) {
    console.error("Error fetching orders by slot:", error);
    return res.status(500).json({ message: "An error occurred while fetching orders.", error });
  }
});


export { getOrdersBySlot };

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
        "Farmer name": obj.farmer?.name,
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
const updateOrder = updateOne(Order, "Order",[
  "bookingSlot",
  "numberOfPlants",
  "rate",
  "orderPaymentStatus",
  "notes",
  'farmReadyDate',
  'orderStatus',
  'farmReadyDate'
]);
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
    // Validate input
    if (!orderId || !paymentId || !paymentStatus) {
      return res.status(400).json({ message: "Order ID, Payment ID, and Payment Status are required." });
    }

    // Find the order by orderId
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    // Find the payment in the order's payments array by paymentId
    const payment = order.payment.id(paymentId);
    if (!payment) {
      return res.status(404).json({ message: "Payment not found." });
    }
console.log(payment)
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
