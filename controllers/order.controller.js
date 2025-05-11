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
/**
 * Add a new payment to an order and update dealer wallet accordingly
 */
const validateDealerId = (dealerId) => {
  if (!dealerId) return null;

  try {
    return mongoose.Types.ObjectId(dealerId);
  } catch (err) {
    console.error("Invalid dealer ID format:", dealerId);
    return null;
  }
};
const addNewPayment = catchAsync(async (req, res, next) => {
  console.log("\n========== PAYMENT CONTROLLER DEBUGGING ==========");
  console.log("Request params:", req.params);
  console.log("Request body:", req.body);

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
    // Find the order
    console.log("Finding order with ID:", orderId);
    const order = await Order.findById(orderId);
    if (!order) {
      console.error("Order not found");
      return res.status(404).json({ message: "Order not found" });
    }

    console.log("Order found:");
    console.log("- ID:", order._id);
    console.log("- Dealer:", order.dealer);
    console.log("- Dealer Type:", typeof order.dealer);
    console.log("- isDealerOrder:", order.dealerOrder);

    // Check if order has a dealer
    if (!order.dealer) {
      console.warn("Order has no dealer associated");
    }

    // Convert paidAmount to number
    const amount = Number(paidAmount);
    if (isNaN(amount)) {
      console.error("Invalid payment amount");
      return res.status(400).json({ message: "Invalid payment amount" });
    }

    console.log("Payment details:");
    console.log("- Amount:", amount);
    console.log("- Status:", paymentStatus);
    console.log("- Is wallet payment:", isWalletPayment ? "Yes" : "No");
    console.log("- Mode:", modeOfPayment);

    // Create the payment object
    const newPayment = {
      paidAmount: amount,
      paymentStatus,
      paymentDate,
      bankName,
      receiptPhoto,
      modeOfPayment,
      isWalletPayment,
    };

    // Add the payment to order
    console.log("Adding payment to order");
    order.payment.push(newPayment);

    // Save the order with the new payment
    console.log("Saving order...");
    await order.save();
    console.log("Order saved successfully");

    // Process wallet transaction if needed
    let transaction = null;
    const dealerId = order.dealer;

    if (dealerId) {
      try {
        // First, debug the current wallet state
        console.log("Checking current wallet state for dealer:", dealerId);
        await DealerWallet.debugWallet(dealerId);

        // Determine transaction type and amount
        let walletAmount = 0;
        let description = "";

        // Wallet impact based on payment type and status
        if (isWalletPayment && paymentStatus === "PENDING") {
          // Deduct from wallet (negative amount)
          walletAmount = -amount;
          description = `Wallet payment for Order #${order._id}`;
          console.log("This is a wallet payment, deducting amount from wallet");
        } else if (order.dealerOrder && paymentStatus === "COLLECTED") {
          // Add to wallet (positive amount)
          walletAmount = amount;
          description = `Payment collected for Order #${order._id} via ${modeOfPayment}`;
          console.log(
            "This is a collected payment for dealer order, adding to wallet"
          );
        } else {
          console.log("Payment does not meet criteria for wallet transaction");
        }

        // If there's a wallet impact, record the transaction
        if (walletAmount !== 0) {
          console.log(
            `Recording wallet transaction: amount=${walletAmount}, description="${description}"`
          );

          const performedBy = req.user?._id || dealerId;
          console.log("Transaction performed by:", performedBy);

          // Use the addPayment method
          transaction = await DealerWallet.addPayment(
            dealerId,
            walletAmount, // Positive for credit, negative for debit
            description,
            performedBy,
            "ORDER_PAYMENT",
            order._id
          );

          // Check transaction result
          if (transaction) {
            console.log("Transaction recorded successfully:");
            console.log("- Type:", transaction.type);
            console.log("- Amount:", transaction.amount);
            console.log("- Balance After:", transaction.balanceAfter);
          } else {
            console.error(
              "Failed to record transaction - null result returned"
            );
          }

          // Debug wallet state after transaction
          console.log("Checking wallet state after transaction:");
          await DealerWallet.debugWallet(dealerId);
        }
      } catch (walletError) {
        // Log the error but don't fail the payment addition
        console.error("Error updating wallet:", walletError);

        return res.status(200).json({
          message: "Payment added to order but wallet update failed",
          error: walletError.message,
          updatedOrder: order,
        });
      }
    } else {
      console.log(
        "No dealer associated with this order, skipping wallet transaction"
      );
    }

    // Return success with transaction info if it was created
    if (transaction) {
      console.log("Returning success response with transaction");
      console.log(
        "========== PAYMENT CONTROLLER DEBUGGING COMPLETE ==========\n"
      );
      return res.status(200).json({
        message: "Payment added successfully and wallet updated",
        updatedOrder: order,
        transaction,
      });
    }

    // Return success if no wallet transaction was needed
    console.log("Returning success response without transaction");
    console.log(
      "========== PAYMENT CONTROLLER DEBUGGING COMPLETE ==========\n"
    );
    return res.status(200).json({
      message: "Payment added successfully",
      updatedOrder: order,
    });
  } catch (error) {
    console.error("Error adding payment:", error);
    console.log(
      "========== PAYMENT CONTROLLER DEBUGGING COMPLETE ==========\n"
    );
    return res.status(500).json({
      message: "Server error while processing payment",
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

/**
 * Alternative implementation using the simpler addPayment helper method
 */
const addNewPaymentAlternative = catchAsync(async (req, res, next) => {
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
    // Find the order
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
      paidAmount: amount,
      paymentStatus,
      paymentDate,
      bankName,
      receiptPhoto,
      modeOfPayment,
      isWalletPayment,
    };

    // Add the payment to order
    order.payment.push(newPayment);
    await order.save();

    // Process wallet transaction if needed
    if (order.dealer) {
      let walletAmount = 0;
      let description = "";

      // Determine the wallet impact
      if (isWalletPayment && paymentStatus === "PENDING") {
        // Deduct from wallet (negative amount)
        walletAmount = -amount;
        description = `Wallet payment for Order #${order._id}`;
      } else if (order.dealerOrder && paymentStatus === "COLLECTED") {
        // Add to wallet (positive amount)
        walletAmount = amount;
        description = `Payment collected for Order #${order._id} via ${modeOfPayment}`;
      }

      // Process the wallet transaction if there is an impact
      if (walletAmount !== 0) {
        try {
          // Use the simpler addPayment method that handles positive/negative amounts
          const transaction = await DealerWallet.addPayment(
            order.dealer,
            walletAmount, // Positive for credit, negative for debit
            description,
            req.user._id,
            "ORDER_PAYMENT",
            order._id
          );

          return res.status(200).json({
            message: "Payment added successfully and wallet updated",
            updatedOrder: order,
            transaction,
          });
        } catch (walletError) {
          console.error("Error updating wallet:", walletError);
          return res.status(200).json({
            message: "Payment added successfully but wallet update failed",
            updatedOrder: order,
            walletError: walletError.message,
          });
        }
      }
    }

    // Return success if no wallet transaction was needed
    return res.status(200).json({
      message: "Payment added successfully",
      updatedOrder: order,
    });
  } catch (error) {
    console.error("Error adding payment:", error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
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
        status: "fail",
        message: "Dispatch not found",
      });
    }

    // Initialize afterDispatchedOrderIds array if it doesn't exist
    if (!dispatch.afterDispatchedOrderIds) {
      dispatch.afterDispatchedOrderIds = [];
    }

    // Add the new order IDs to the afterDispatchedOrderIds array
    dispatch.afterDispatchedOrderIds = [
      ...dispatch.afterDispatchedOrderIds,
      ...orderIds,
    ];

    // Save the updated dispatch
    await dispatch.save();

    return res.status(200).json({
      status: "success",
      message: "After dispatched order IDs added successfully",
      data: {
        dispatch,
      },
    });
  } catch (error) {
    console.error("Error adding after dispatched order IDs:", error);
    return res.status(500).json({
      status: "error",
      message: "An error occurred while adding after dispatched order IDs.",
      error: error.message,
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
  addAfterDispatchedOrderIds,
  addNewPaymentAlternative,
};
