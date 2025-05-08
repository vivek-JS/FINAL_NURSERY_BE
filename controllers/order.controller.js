import { Parser as CsvParser } from "json2csv";
import catchAsync from "../utility/catchAsync.js";
import Order from "../models/order.model.js";
import { getAll, createOne, updateOne } from "./factory.controller.js";
import DealerWallet from "../models/dealerWallet.js";

const updateDealerWalletBalance = async (dealerId, paymentAmount) => {
  let wallet = await DealerWallet.findOne({ dealer: dealerId });

  if (!wallet) {
    wallet = new DealerWallet({
      dealer: dealerId,
      availableAmount: paymentAmount,
      entries: [],
    });
  } else {
    wallet.availableAmount += paymentAmount;
  }

  await wallet.save({});
};
const createDealerOrder = createOne(Order, "Order");
const getOrdersBySlot = catchAsync(async (req, res, next) => {
  const { slotId } = req.params; // Extract the slotId from the request parameters

  try {
    // Find all orders related to the given slotId
    const orders = await Order.find({ bookingSlot: slotId })
      .populate("farmer", "name mobileNumber village taluka district") // Populate farmer details
      .populate("salesPerson", "name phoneNumber") // Populate salesperson details
      .populate("plantName", "name") // Populate plant name
      .populate("plantSubtype", "name") // Populate plant subtype
      .populate("bookingSlot") // Populate the booking slot
      .exec();

    if (!orders || orders.length === 0) {
      return res
        .status(404)
        .json({ message: "No orders found for the specified slot." });
    }

    // Send all the order details along with populated references as a response
    return res.status(200).json({
      message: "Orders fetched successfully.",
      orders: orders.map((order) => {
        return {
          id: order._id, // Returning the order ID
          _id: order._id, // The same as the `id` field in your sample
          farmer: {
            _id: order.farmer?._id,
            name: order.farmer?.name,
            village: order.farmer?.village,
            taluka: order.farmer?.taluka,
            district: order.farmer?.district,
            mobileNumber: order.farmer?.mobileNumber,
          },
          salesPerson: {
            _id: order.salesPerson?._id,
            name: order.salesPerson?.name,
            phoneNumber: order.salesPerson?.phoneNumber,
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
            month: order?.bookingSlot?.month,
          },
          rate: order?.rate,
          orderPaymentStatus: order?.orderPaymentStatus,
          orderStatus: order?.orderStatus,
          payment: order?.payment,
          createdAt: order?.createdAt,
          updatedAt: order?.updatedAt,
          salesPersonName: order.salesPerson?.name, // salesPersonName
          salesPersonPhoneNumber: order.salesPerson?.phoneNumber, // salesPersonPhoneNumber
        };
      }),
    });
  } catch (error) {
    console.error("Error fetching orders by slot:", error);
    return res
      .status(500)
      .json({ message: "An error occurred while fetching orders.", error });
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
const updateOrder = updateOne(Order, "Order", [
  "bookingSlot",
  "numberOfPlants",
  "rate",
  "orderPaymentStatus",
  "notes",
  "farmReadyDate",
  "orderStatus",
  "farmReadyDate",
  "orderRemarks",
]);
const addNewPayment = catchAsync(async (req, res, next) => {
  const { orderId } = req.params;
  const {
    paidAmount,
    paymentStatus,
    paymentDate,
    bankName,
    receiptPhoto,
    modeOfPayment,
    isWalletPayment,
  } = req.body;

  try {
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Convert paidAmount to number
    const amount = Number(paidAmount);
    if (isNaN(amount)) {
      return res.status(400).json({ message: "Invalid payment amount" });
    }

    // Create the payment object
    const newPayment = {
      paidAmount: amount, // Store as number
      paymentStatus,
      paymentDate,
      bankName,
      receiptPhoto,
      modeOfPayment,
      isWalletPayment,
    };

    // Add the payment to order
    order.payment.push(newPayment);

    // If it's a wallet payment and status is PENDING, add to dealer's wallet
    if (isWalletPayment && paymentStatus === "PENDING") {
      await updateDealerWalletBalance(order.dealer, -amount);
    }
    // Regular payment flow
    else if (
      order.dealerOrder &&
      order.dealer &&
      paymentStatus === "COLLECTED"
    ) {
      await updateDealerWalletBalance(order.dealer, amount);
    }

    await order.save();

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

    if (!orderId || !paymentId || !paymentStatus) {
      return res.status(400).json({
        message: "Order ID, Payment ID, and Payment Status are required.",
      });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    const payment = order.payment.id(paymentId);
    if (!payment) {
      return res.status(404).json({ message: "Payment not found." });
    }

    // Ensure amount is a number
    const amount = Number(payment.paidAmount);
    if (isNaN(amount)) {
      return res
        .status(400)
        .json({ message: "Invalid payment amount in record" });
    }

    // Handle wallet payment status changes
    if (payment.isWalletPayment) {
      console.log(payment);
      console.log(paymentStatus);
      // If payment is being rejected, subtract from wallet
      if (payment.paymentStatus === "REJECTED" && paymentStatus === "PENDING") {
        await updateDealerWalletBalance(order.dealer, amount);
      } else if (
        payment.paymentStatus === "COLLECTED" &&
        paymentStatus === "REJECTED"
      ) {
        await updateDealerWalletBalance(order.dealer, amount);
      } else if (
        payment.paymentStatus === "REJECTED" &&
        paymentStatus === "COLLECTED"
      ) {
        await updateDealerWalletBalance(order.dealer, -amount);
      } else if (
        payment.paymentStatus === "COMPLETED" &&
        paymentStatus === "REJECTED"
      ) {
        await updateDealerWalletBalance(order.dealer, -amount);
      } else if (
        payment.paymentStatus === "PENDING" &&
        paymentStatus === "REJECTED"
      ) {
        await updateDealerWalletBalance(order.dealer, amount);
      }
    }
    // Regular payment flow for non-wallet payments
    else if (order.dealerOrder && order.dealer) {
      if (
        payment.paymentStatus !== "COLLECTED" &&
        paymentStatus === "COLLECTED"
      ) {
        await updateDealerWalletBalance(order.dealer, amount);
      } else if (
        payment.paymentStatus === "COLLECTED" &&
        paymentStatus !== "COLLECTED"
      ) {
        await updateDealerWalletBalance(order.dealer, -amount);
      }
    }

    payment.paymentStatus = paymentStatus;
    await order.save();

    return res.status(200).json({
      message: "Payment status updated successfully.",
      order,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "An error occurred while updating the payment status.",
      error,
    });
  }
};


const addAfterDispatchedOrderIds = catchAsync(async (req, res, next) => {
  const { dispatchId } = req.params;
  const { orderIds } = req.body;

  try {
    // Find the dispatch by ID
    const dispatch = await Dispatch.findById(dispatchId);
    
    if (!dispatch) {
      return res.status(404).json({ 
        status: 'fail', 
        message: "Dispatch not found" 
      });
    }
    
    // Initialize afterDispatchedOrderIds array if it doesn't exist
    if (!dispatch.afterDispatchedOrderIds) {
      dispatch.afterDispatchedOrderIds = [];
    }
    
    // Add the new order IDs to the afterDispatchedOrderIds array
    dispatch.afterDispatchedOrderIds = [
      ...dispatch.afterDispatchedOrderIds,
      ...orderIds
    ];
    
    // Save the updated dispatch
    await dispatch.save();
    
    return res.status(200).json({
      status: 'success',
      message: "After dispatched order IDs added successfully",
      data: {
        dispatch
      }
    });
  } catch (error) {
    console.error("Error adding after dispatched order IDs:", error);
    return res.status(500).json({ 
      status: 'error',
      message: "An error occurred while adding after dispatched order IDs.", 
      error: error.message 
    });
  }
});


export {
  getCsv,
  createOrder,
  updateOrder,
  addNewPayment,
  getOrders,
  updatePaymentStatus,
  createDealerOrder,
  addAfterDispatchedOrderIds
};
