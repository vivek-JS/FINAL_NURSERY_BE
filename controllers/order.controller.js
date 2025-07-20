import { Parser as CsvParser } from "json2csv";
import catchAsync from "../utility/catchAsync.js";
import Order from "../models/order.model.js";
import { getAll, createOne, updateOne } from "./factory.controller.js";
import DealerWallet from "../models/dealerWallet.js";
import Dispatch from "../models/dispatch.model.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import mongoose from "mongoose";
import User from "../models/user.model.js";
import Farmer from "../models/farmer.model.js";

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

// export { getOrdersBySlot };

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
    // Find the order and populate farmer details
    console.log("Finding order with ID:", orderId);
    const order = await Order.findById(orderId).populate('farmer', 'name village');
    if (!order) {
      console.error("Order not found");
      return res.status(404).json({ message: "Order not found" });
    }

    console.log("Order found:");
    console.log("- ID:", order._id);
    console.log("- Dealer:", order.dealer);
    console.log("- Dealer Type:", typeof order.dealer);
    console.log("- Sales Person:", order.salesPerson);
    console.log("- isDealerOrder:", order.dealerOrder);

    // Check if order has a dealer
    if (!order.dealer) {
      console.warn("Order has no dealer field, will check salesPerson");
    }

    // Convert paidAmount to number
    const amount = Number(paidAmount);
    if (isNaN(amount)) {
      console.error("Invalid payment amount");
      return res.status(400).json({ message: "Invalid payment amount" });
    }

    // ENFORCE PENDING STATUS FOR ALL NEW PAYMENTS
    // Only Accountants and Super Admins can change status later
    const userRole = req.user?.role;
    const finalPaymentStatus = "PENDING"; // Always PENDING for new payments

    console.log("Payment details:");
    console.log("- Amount:", amount);
    console.log("- Requested Status:", paymentStatus);
    console.log("- Final Status:", finalPaymentStatus);
    console.log("- User Role:", userRole);
    console.log("- Is wallet payment:", isWalletPayment ? "Yes" : "No");
    console.log("- Mode:", modeOfPayment);

    // Create the payment object
    const newPayment = {
      paidAmount: amount,
      paymentStatus: finalPaymentStatus,
      paymentDate,
      bankName,
      receiptPhoto,
      modeOfPayment,
      isWalletPayment,
    };

    // Extract farmer details BEFORE saving (to avoid losing populated data)
    console.log("DEBUG: Farmer data check BEFORE saving:");
    console.log("- order.dealerOrder:", order.dealerOrder);
    console.log("- order.farmer:", order.farmer);
    console.log("- order.farmer type:", typeof order.farmer);
    console.log("- order.farmer name:", order.farmer?.name);
    console.log("- order.farmer village:", order.farmer?.village);
    
    let farmerInfo = 'Unknown Customer';
    if (order.dealerOrder) {
      // For dealer orders, use dealer info instead of farmer
      farmerInfo = 'Dealer Order';
      console.log("DEBUG: Using Dealer Order for description");
    } else if (order.farmer && typeof order.farmer === 'object' && order.farmer.name) {
      // For farmer orders, use farmer name and village
      const farmerName = order.farmer.name || 'Unknown Farmer';
      const farmerVillage = order.farmer.village || 'Unknown Village';
      farmerInfo = `${farmerName} (${farmerVillage})`;
      console.log("DEBUG: Using farmer info:", farmerInfo);
    } else {
      console.log("DEBUG: No farmer data found, using Unknown Customer");
    }

    // Add the payment to order
    console.log("Adding payment to order");
    order.payment.push(newPayment);

    // Save the order with the new payment
    console.log("Saving order...");
    await order.save();
    console.log("Order saved successfully");

    // Process wallet transaction if needed
    let transaction = null;
    
    // Get dealer ID from order.dealer or from salesPerson if they are a dealer
    let dealerId = order.dealer;
    
    // If no dealer field, check if salesPerson is a dealer
    if (!dealerId && order.salesPerson) {
      try {
        // Fetch the sales person to check their jobTitle
        const User = mongoose.model('User');
        const salesPerson = await User.findById(order.salesPerson);
        if (salesPerson && salesPerson.jobTitle === 'DEALER') {
          dealerId = salesPerson._id;
          console.log("Found dealer from salesPerson:", dealerId);
        }
      } catch (error) {
        console.error("Error fetching sales person:", error);
      }
    }

    if (dealerId) {
      console.log("Processing wallet transaction for dealer:", dealerId);
      try {
        // First, debug the current wallet state
        console.log("Checking current wallet state for dealer:", dealerId);
        await DealerWallet.debugWallet(dealerId);

        // Determine transaction type and amount
        let walletAmount = 0;
        let description = "";

        // Wallet impact based on payment type and status
        if (isWalletPayment && finalPaymentStatus === "PENDING") {
          // Deduct from wallet (negative amount) - when dealer pays from wallet
          walletAmount = -amount;
          description = `Wallet payment for Order #${order._id} - ${farmerInfo}`;
          console.log("This is a wallet payment, deducting amount from wallet");
        } else if (isWalletPayment && finalPaymentStatus === "COLLECTED") {
          // Deduct from wallet (negative amount) - when dealer pays from wallet and it's collected
          walletAmount = -amount;
          description = `Wallet payment collected for Order #${order._id} - ${farmerInfo}`;
          console.log("This is a collected wallet payment, deducting amount from wallet");
        } else if (order.dealerOrder && finalPaymentStatus === "COLLECTED") {
          // Add to wallet (positive amount) - when payment is collected from dealer
          walletAmount = amount;
          description = `Payment collected for Order #${order._id} via ${modeOfPayment} - ${farmerInfo}`;
          console.log(
            "This is a collected payment for dealer order, adding to wallet"
          );
        } else if (order.dealerOrder && isWalletPayment && finalPaymentStatus === "COLLECTED") {
          // Special case: Dealer order with wallet payment marked as collected
          // This means the dealer is using their wallet balance to pay
          walletAmount = -amount;
          description = `Wallet payment collected for Dealer Order #${order._id} - ${farmerInfo}`;
          console.log("This is a dealer wallet payment being collected");
        } else if (order.dealerOrder && !isWalletPayment && finalPaymentStatus === "PENDING") {
          // Dealer order with regular payment marked as pending
          // This means we're recording a pending payment from dealer
          walletAmount = 0; // No immediate wallet impact for pending payments
          description = `Pending payment recorded for Dealer Order #${order._id} - ${farmerInfo}`;
          console.log("This is a pending payment for dealer order");
        } else {
          console.log("Payment does not meet criteria for wallet transaction");
          console.log("Debug info:");
          console.log("- isWalletPayment:", isWalletPayment);
          console.log("- finalPaymentStatus:", finalPaymentStatus);
          console.log("- order.dealerOrder:", order.dealerOrder);
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
        "No dealer found (neither order.dealer nor salesPerson as dealer), skipping wallet transaction"
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
    // Find the order and populate farmer details
    const order = await Order.findById(orderId).populate('farmer', 'name village');
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    
    console.log("DEBUG: Order after population:");
    console.log("- order.farmer:", order.farmer);
    console.log("- order.farmer type:", typeof order.farmer);
    console.log("- order.farmer name:", order.farmer?.name);
    console.log("- order.farmer village:", order.farmer?.village);

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

      // Get farmer details for description
      let farmerInfo = 'Unknown Customer';
      if (order.dealerOrder) {
        // For dealer orders, use dealer info instead of farmer
        farmerInfo = 'Dealer Order';
      } else if (order.farmer) {
        // For farmer orders, use farmer name and village
        const farmerName = order.farmer.name || 'Unknown Farmer';
        const farmerVillage = order.farmer.village || 'Unknown Village';
        farmerInfo = `${farmerName} (${farmerVillage})`;
      }

      // Determine the wallet impact
      if (isWalletPayment && paymentStatus === "PENDING") {
        // Deduct from wallet (negative amount)
        walletAmount = -amount;
        description = `Wallet payment for Order #${order._id} - ${farmerInfo}`;
      } else if (order.dealerOrder && paymentStatus === "COLLECTED") {
        // Add to wallet (positive amount)
        walletAmount = amount;
        description = `Payment collected for Order #${order._id} via ${modeOfPayment} - ${farmerInfo}`;
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
    const { 
      orderId, 
      paymentId, 
      paymentStatus, 
      paidAmount, 
      paymentDate, 
      modeOfPayment, 
      bankName, 
      remark 
    } = req.body;

    if (!orderId || !paymentId || !paymentStatus) {
      return res.status(400).json({
        message: "Order ID, Payment ID, and Payment Status are required.",
      });
    }

    // Find order by orderId field (numeric) instead of _id (ObjectId)
    const order = await Order.findOne({ orderId: orderId });
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    const payment = order.payment.id(paymentId);
    if (!payment) {
      return res.status(404).json({ message: "Payment not found." });
    }

    // Update payment fields if provided
    if (paidAmount !== undefined) {
      payment.paidAmount = Number(paidAmount);
    }
    if (paymentDate !== undefined) {
      payment.paymentDate = new Date(paymentDate);
    }
    if (modeOfPayment !== undefined) {
      payment.modeOfPayment = modeOfPayment;
    }
    if (bankName !== undefined) {
      payment.bankName = bankName;
    }
    if (remark !== undefined) {
      payment.remark = remark;
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
      success: true,
      message: "Payment status updated successfully.",
      order,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while updating the payment status.",
      error: error.message,
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

// Get orders by specific status
const getOrdersByStatus = catchAsync(async (req, res, next) => {
  const { status, startDate, endDate, page = 1, limit = 100, search } = req.query;
  
  try {
    const order = -1; // desc order
    const skip = (page - 1) * limit;

    // Build the aggregation pipeline
    const pipeline = [];

    // Status filter
    if (status) {
      const statusArray = status.split(",").map((s) => s.trim());
      pipeline.push({
        $match: {
          orderStatus: { $in: statusArray },
        },
      });
    }

    // Date range filtering
    if (startDate && endDate) {
      const parseDate = (dateStr, isEnd = false) => {
        const [day, month, year] = dateStr.split("-");
        return isEnd
          ? new Date(`${year}-${month}-${day}T23:59:59.999Z`)
          : new Date(`${year}-${month}-${day}T00:00:00.000Z`);
      };

      const start = parseDate(startDate);
      const end = parseDate(endDate, true);
      pipeline.push({ $match: { orderBookingDate: { $gte: start, $lte: end } } });
    }

    // Search filtering
    if (search) {
      const searchRegex = new RegExp(search, "i");

      pipeline.push({
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      });

      pipeline.push({
        $addFields: {
          "farmer.mobileNumberStr": {
            $toString: { $arrayElemAt: ["$farmer.mobileNumber", 0] },
          },
        },
      });

      const isNumeric = /^\d+$/.test(search);
      const searchAsNumber = isNumeric ? Number(search) : NaN;

      pipeline.push({
        $match: {
          $or: [
            { orderId: isNumeric ? searchAsNumber : search },
            { "farmer.name": searchRegex },
            { "farmer.mobileNumberStr": searchRegex },
          ],
        },
      });
    } else {
      pipeline.push({
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      });
    }

    // Common lookups
    pipeline.push(
      {
        $lookup: {
          from: "plantcms",
          localField: "plantName",
          foreignField: "_id",
          as: "plantName",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "salesPerson",
          foreignField: "_id",
          as: "salesPerson",
        },
      },
      {
        $lookup: {
          from: "trays",
          localField: "cavity",
          foreignField: "_id",
          as: "cavityDetails",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "statusChanges.changedBy",
          foreignField: "_id",
          as: "statusChangeUsers",
        },
      }
    );

    // Standard booking slot lookup
    pipeline.push({
      $lookup: {
        from: "plantslots",
        let: { bookingSlotId: "$bookingSlot" },
        pipeline: [
          { $unwind: "$subtypeSlots" },
          { $unwind: "$subtypeSlots.slots" },
          {
            $match: {
              $expr: {
                $eq: [
                  { $toString: "$subtypeSlots.slots._id" },
                  { $toString: "$$bookingSlotId" },
                ],
              },
            },
          },
          {
            $project: {
              _id: 0,
              slotId: "$subtypeSlots.slots._id",
              startDay: "$subtypeSlots.slots.startDay",
              endDay: "$subtypeSlots.slots.endDay",
              subtypeId: "$subtypeSlots.subtypeId",
              month: "$subtypeSlots.slots.month",
            },
          },
        ],
        as: "bookingSlotDetails",
      },
    });

    // Enrich plantSubtype details
    pipeline.push({
      $set: {
        plantSubtypeDetails: {
          $arrayElemAt: [
            {
              $filter: {
                input: { $arrayElemAt: ["$plantName.subtypes", 0] },
                as: "subtype",
                cond: { $eq: ["$$subtype._id", "$plantSubtype"] },
              },
            },
            0,
          ],
        },
      },
    });



    // Project required fields
    pipeline.push(
      {
        $project: {
          farmer: {
            $arrayElemAt: [
              {
                $map: {
                  input: "$farmer",
                  as: "farmerData",
                  in: {
                    name: "$$farmerData.name",
                    mobileNumber: "$$farmerData.mobileNumber",
                    village: "$$farmerData.village",
                    taluka: "$$farmerData.taluka",
                    district: "$$farmerData.district",
                    state: "$$farmerData.state",
                    stateName: "$$farmerData.stateName",
                    districtName: "$$farmerData.districtName",
                    talukaName: "$$farmerData.talukaName",
                  },
                },
              },
              0,
            ],
          },
          plantType: {
            id: { $arrayElemAt: ["$plantName._id", 0] },
            name: { $arrayElemAt: ["$plantName.name", 0] },
          },
          plantSubtype: {
            id: "$plantSubtypeDetails._id",
            name: "$plantSubtypeDetails.name",
          },
          cavity: {
            id: { $arrayElemAt: ["$cavityDetails._id", 0] },
            name: { $arrayElemAt: ["$cavityDetails.name", 0] },
            cavity: { $arrayElemAt: ["$cavityDetails.cavity", 0] },
            numberPerCrate: {
              $arrayElemAt: ["$cavityDetails.numberPerCrate", 0],
            },
          },
          bookingSlot: "$bookingSlotDetails",
          salesPerson: {
            $arrayElemAt: [
              {
                $map: {
                  input: "$salesPerson",
                  as: "sales",
                  in: {
                    name: "$$sales.name",
                    phoneNumber: "$$sales.phoneNumber",
                  },
                },
              },
              0,
            ],
          },
          createdAt: 1,
          orderStatus: 1,
          payment: 1,
          numberOfPlants: 1,
          remainingPlants: 1,
          returnedPlants: 1,
          returnReason: 1,
          returnHistory: 1,
          orderId: 1,
          rate: 1,
          farmReadyDate: 1,
          orderBookingDate: 1,
          orderPaymentStatus: 1,
          paymentCompleted: 1,
          dealerOrder: 1,
          notes: 1,
          orderRemarks: 1,
          statusChanges: {
            $map: {
              input: "$statusChanges",
              as: "change",
              in: {
                previousStatus: "$$change.previousStatus",
                newStatus: "$$change.newStatus",
                reason: "$$change.reason",
                notes: "$$change.notes",
                changedAt: "$$change.createdAt",
                changedBy: {
                  $cond: {
                    if: "$$change.changedBy",
                    then: {
                      $let: {
                        vars: {
                          userId: { $toString: "$$change.changedBy" }
                        },
                        in: {
                          $let: {
                            vars: {
                              userData: {
                                $arrayElemAt: [
                                  {
                                    $filter: {
                                      input: "$statusChangeUsers",
                                      as: "user",
                                      cond: { $eq: [{ $toString: "$$user._id" }, "$$userId"] }
                                    }
                                  },
                                  0
                                ]
                              }
                            },
                            in: {
                              $ifNull: [
                                {
                                  _id: "$$userData._id",
                                  name: "$$userData.name",
                                  phoneNumber: "$$userData.phoneNumber"
                                },
                                { _id: "$$change.changedBy" }
                              ]
                            }
                          }
                        }
                      }
                    },
                    else: null,
                  },
                },
              },
            },
          },
          deliveryChanges: {
            $map: {
              input: "$deliveryChanges",
              as: "change",
              in: {
                previousDeliveryDate: "$$change.previousDeliveryDate",
                newDeliveryDate: "$$change.newDeliveryDate",
                reasonForChange: "$$change.reasonForChange",
                changedAt: "$$change.createdAt",
              },
            },
          },
        },
      },
      { $sort: { createdAt: order } },
      { $skip: skip },
      { $limit: parseInt(limit, 10) }
    );

    // Execute the pipeline
    const results = await Order.aggregate(pipeline);

    // Transform documents for response
    const transformedResults = results.map((item) => {
      const { _id, ...rest } = item;
      return { id: _id, _id, ...rest };
    });

    const response = generateResponse(
      "Success",
      `Orders with status ${status} found successfully`,
      transformedResults,
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching orders by status:", error);
    return res.status(500).json({ 
      message: "An error occurred while fetching orders.", 
      error: error.message 
    });
  }
});

// Get all payments with date filtering
const getAllPayments = catchAsync(async (req, res, next) => {
  const { startDate, endDate, paymentStatus, page = 1, limit = 100, search } = req.query;
  
  try {
    const order = -1; // desc order
    const skip = (page - 1) * limit;

    // Build the aggregation pipeline
    const pipeline = [];

    // Unwind payments to work with individual payment records
    pipeline.push({
      $unwind: {
        path: "$payment",
        preserveNullAndEmptyArrays: false
      }
    });

    // Payment status filter
    if (paymentStatus) {
      const statusArray = paymentStatus.split(",").map((s) => s.trim());
      pipeline.push({
        $match: {
          "payment.paymentStatus": { $in: statusArray },
        },
      });
    }

    // Date range filtering for payment date
    if (startDate && endDate) {
      try {
        const parseDate = (dateStr, isEnd = false) => {
          const [day, month, year] = dateStr.split("-");
          return isEnd
            ? new Date(`${year}-${month}-${day}T23:59:59.999Z`)
            : new Date(`${year}-${month}-${day}T00:00:00.000Z`);
        };

        const start = parseDate(startDate);
        const end = parseDate(endDate, true);
        
        // Only add date filter if dates are valid
        if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
          pipeline.push({ 
            $match: { 
              "payment.paymentDate": { $gte: start, $lte: end } 
            } 
          });
        }
      } catch (dateError) {
        console.error("Date parsing error:", dateError);
        // Continue without date filter if parsing fails
      }
    }

    // Search filtering
    if (search) {
      const searchRegex = new RegExp(search, "i");

      pipeline.push({
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      });

      pipeline.push({
        $addFields: {
          "farmer.mobileNumberStr": {
            $toString: { $arrayElemAt: ["$farmer.mobileNumber", 0] },
          },
        },
      });

      const isNumeric = /^\d+$/.test(search);
      const searchAsNumber = isNumeric ? Number(search) : NaN;

      pipeline.push({
        $match: {
          $or: [
            { orderId: isNumeric ? searchAsNumber : search },
            { "farmer.name": searchRegex },
            { "farmer.mobileNumberStr": searchRegex },
          ],
        },
      });
    } else {
      pipeline.push({
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      });
    }

    // Common lookups
    pipeline.push(
      {
        $lookup: {
          from: "plantcms",
          localField: "plantName",
          foreignField: "_id",
          as: "plantName",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "salesPerson",
          foreignField: "_id",
          as: "salesPerson",
        },
      }
    );

    // Project payment-focused fields
    pipeline.push({
      $project: {
        orderId: 1,
        orderStatus: 1,
        orderPaymentStatus: 1,
        numberOfPlants: 1,
        rate: 1,
        totalOrderAmount: { $multiply: ["$rate", "$numberOfPlants"] },
        farmer: {
          $arrayElemAt: [
            {
              $map: {
                input: "$farmer",
                as: "farmerData",
                in: {
                  name: "$$farmerData.name",
                  mobileNumber: "$$farmerData.mobileNumber",
                  village: "$$farmerData.village",
                  taluka: "$$farmerData.taluka",
                  district: "$$farmerData.district",
                },
              },
            },
            0,
          ],
        },
        plantType: {
          id: { $arrayElemAt: ["$plantName._id", 0] },
          name: { $arrayElemAt: ["$plantName.name", 0] },
        },
        salesPerson: {
          $arrayElemAt: [
            {
              $map: {
                input: "$salesPerson",
                as: "sales",
                in: {
                  name: "$$sales.name",
                  phoneNumber: "$$sales.phoneNumber",
                },
              },
            },
            0,
          ],
        },
        payment: 1,
        orderBookingDate: 1,
        createdAt: 1,
        dealerOrder: 1,
      },
    });

    // Sort by payment date with fallback to createdAt
    pipeline.push({ 
      $sort: { 
        "payment.paymentDate": order,
        "createdAt": order 
      } 
    });
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: parseInt(limit, 10) });

    // Execute the pipeline with error handling
    let results;
    try {
      results = await Order.aggregate(pipeline);
    } catch (aggregateError) {
      console.error("Aggregation error:", aggregateError);
      return res.status(500).json({ 
        status: "error",
        message: "Database query failed", 
        error: aggregateError.message 
      });
    }

    // Transform documents for response
    const transformedResults = results.map((item) => {
      const { _id, ...rest } = item;
      return { id: _id, _id, ...rest };
    });

    const response = generateResponse(
      "Success",
      "Payments found successfully",
      transformedResults,
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching payments:", error);
    return res.status(500).json({ 
      status: "error",
      message: "An error occurred while fetching payments.", 
      error: error.message 
    });
  }
});

// Get unique villages from orders
const getUniqueVillages = catchAsync(async (req, res, next) => {
  try {
    const villages = await Order.aggregate([
      {
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      },
      {
        $unwind: "$farmer",
      },
      {
        $group: {
          _id: "$farmer.village",
        },
      },
      {
        $match: {
          _id: { $ne: null, $ne: "" },
        },
      },
      {
        $sort: { _id: 1 },
      },
      {
        $project: {
          _id: 0,
          village: "$_id",
        },
      },
    ]);

    res.status(200).json({
      success: true,
      data: villages.map((v) => v.village),
    });
  } catch (error) {
    console.error("Error fetching unique villages:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while fetching villages.",
      error: error.message,
    });
  }
});

// Get unique districts from orders
const getUniqueDistricts = catchAsync(async (req, res, next) => {
  try {
    const districts = await Order.aggregate([
      {
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      },
      {
        $unwind: "$farmer",
      },
      {
        $group: {
          _id: "$farmer.district",
        },
      },
      {
        $match: {
          _id: { $ne: null, $ne: "" },
        },
      },
      {
        $sort: { _id: 1 },
      },
      {
        $project: {
          _id: 0,
          district: "$_id",
        },
      },
    ]);

    res.status(200).json({
      success: true,
      data: districts.map((d) => d.district),
    });
  } catch (error) {
    console.error("Error fetching unique districts:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while fetching districts.",
      error: error.message,
    });
  }
});

/**
 * Get dealer wallet balance for a specific order
 * This is useful for frontend to display current wallet balance when adding payments
 */
const getDealerWalletBalanceForOrder = catchAsync(async (req, res, next) => {
  const { orderId } = req.params;

  try {
    // Find the order
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ 
        success: false,
        message: "Order not found" 
      });
    }

    // Check if this is a dealer order
    if (!order.dealerOrder || !order.dealer) {
      return res.status(400).json({ 
        success: false,
        message: "This is not a dealer order" 
      });
    }

    // Get dealer information
    const dealer = await User.findById(order.dealer).select('name phoneNumber');
    if (!dealer) {
      return res.status(404).json({ 
        success: false,
        message: "Dealer not found" 
      });
    }

    // Get wallet information
    const wallet = await DealerWallet.findOne({ dealer: order.dealer });
    
    // Calculate order total
    const orderTotal = order.numberOfPlants * order.rate;
    
    // Calculate total paid amount
    const totalPaid = order.payment
      .filter(p => p.paymentStatus === "COLLECTED")
      .reduce((sum, p) => sum + (p.paidAmount || 0), 0);
    
    // Calculate remaining amount
    const remainingAmount = orderTotal - totalPaid;

    const response = {
      success: true,
      message: "Dealer wallet balance retrieved successfully",
      data: {
        order: {
          orderId: order.orderId,
          orderTotal: orderTotal,
          totalPaid: totalPaid,
          remainingAmount: remainingAmount,
          numberOfPlants: order.numberOfPlants,
          rate: order.rate
        },
        dealer: {
          _id: dealer._id,
          name: dealer.name,
          phoneNumber: dealer.phoneNumber
        },
        wallet: wallet ? {
          _id: wallet._id,
          availableAmount: wallet.availableAmount || 0,
          totalQuantity: wallet.entries ? wallet.entries.reduce((sum, entry) => sum + (entry.quantity || 0), 0) : 0,
          totalBookedQuantity: wallet.entries ? wallet.entries.reduce((sum, entry) => sum + (entry.bookedQuantity || 0), 0) : 0,
          totalRemainingQuantity: wallet.entries ? wallet.entries.reduce((sum, entry) => sum + (entry.remainingQuantity || 0), 0) : 0,
          transactionsCount: wallet.transactions ? wallet.transactions.length : 0
        } : {
          availableAmount: 0,
          totalQuantity: 0,
          totalBookedQuantity: 0,
          totalRemainingQuantity: 0,
          transactionsCount: 0
        }
      }
    };

    return res.status(200).json(response);
  } catch (error) {
    console.error("Error getting dealer wallet balance for order:", error);
    return res.status(500).json({
      success: false,
      message: "Error retrieving dealer wallet balance",
      error: error.message
    });
  }
});

export { 
  getOrdersBySlot, 
  getCsv, 
  getOrders, 
  createOrder, 
  updateOrder, 
  addNewPayment, 
  updatePaymentStatus, 
  createDealerOrder, 
  addAfterDispatchedOrderIds,
  getOrdersByStatus,
  getAllPayments,
  getUniqueVillages,
  getUniqueDistricts,
  getDealerWalletBalanceForOrder
};
