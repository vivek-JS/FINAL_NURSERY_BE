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
import Tray from "../models/tray.model.js";
import {
  sendPaymentAcceptedNotification,
  sendPaymentRejectedNotification,
  sendPaymentCollectedNotification,
  sendPaymentPendingNotification,
} from "../utility/pushNotification.js";

const updateDealerWalletBalance = async (dealerId, paymentAmount, description = "Wallet balance adjustment", performedBy = null) => {
  // Validate dealerId
  if (!dealerId) {
    throw new Error("Dealer ID is required for wallet operations");
  }

  // Convert to ObjectId if it's a string
  const dealerObjectId = typeof dealerId === 'string' ? new mongoose.Types.ObjectId(dealerId) : dealerId;
  
  let wallet = await DealerWallet.findOne({ dealer: dealerObjectId });

  if (!wallet) {
    console.log('Creating new wallet for dealer:', dealerObjectId);
    wallet = new DealerWallet({
      dealer: dealerObjectId,
      availableAmount: paymentAmount,
      entries: [],
      transactions: []
    });
    await wallet.save();
  } else {
    // Record transaction before updating balance
    if (paymentAmount !== 0) {
      const transaction = await DealerWallet.addPayment(
        dealerObjectId,
        paymentAmount,
        description,
        performedBy || dealerObjectId,
        "PAYMENT_STATUS_UPDATE",
        null
      );
    }
  }
};
const createDealerOrder = createOne(Order, "Order");
const getOrdersBySlot = catchAsync(async (req, res, next) => {
  const { slotId } = req.params; // Extract the slotId from the request parameters

  try {
    // Use aggregation to properly handle subdocument references
    const orders = await Order.aggregate([
      {
        $match: { bookingSlot: new mongoose.Types.ObjectId(slotId) }
      },
      {
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer"
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "salesPerson",
          foreignField: "_id",
          as: "salesPerson"
        }
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantName",
          foreignField: "_id",
          as: "plantName"
        }
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantSubtype",
          foreignField: "subtypes._id",
          as: "plantSubtypeData"
        }
      },
      {
        $lookup: {
          from: "plantslots",
          localField: "bookingSlot",
          foreignField: "subtypeSlots._id",
          as: "slotData"
        }
      },
      {
        $unwind: { path: "$farmer", preserveNullAndEmptyArrays: true }
      },
      {
        $unwind: { path: "$salesPerson", preserveNullAndEmptyArrays: true }
      },
      {
        $unwind: { path: "$plantName", preserveNullAndEmptyArrays: true }
      },
      {
        $unwind: { path: "$plantSubtypeData", preserveNullAndEmptyArrays: true }
      },
      {
        $unwind: { path: "$slotData", preserveNullAndEmptyArrays: true }
      },
      {
        $addFields: {
          // Extract the matching subtype from the plantSubtypeData
          plantSubtype: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$plantSubtypeData.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$plantSubtype"] }
                }
              },
              0
            ]
          },
          // Extract the matching slot from slotData
          bookingSlotData: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$slotData.subtypeSlots", []] },
                  as: "slot",
                  cond: { $eq: ["$$slot._id", "$bookingSlot"] }
                }
              },
              0
            ]
          }
        }
      }
    ]);

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
          orderBookingDate: order?.orderBookingDate, // Order booking date
          deliveryDate: order?.deliveryDate, // Specific delivery date
          salesPersonName: order.salesPerson?.name, // salesPersonName
          salesPersonPhoneNumber: order.salesPerson?.phoneNumber, // salesPersonPhoneNumber
          orderFor: order?.orderFor, // Add orderFor field
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
  try {
    // extracting data
    const { startDate, endDate, orderStatus, paymentStatus } = req.query;

    // Build query
    let query = {};
    
    if (startDate && endDate) {
      query.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }
    
    if (orderStatus) {
      query.orderStatus = orderStatus;
    }
    
    if (paymentStatus) {
      query.orderPaymentStatus = paymentStatus;
    }

    let jsonData = await Order.find(query)
      .populate("farmer", "name mobileNumber village taluka district")
      .populate("salesPerson", "name phoneNumber")
      .populate("plantName", "name subtypes")
      .populate("dealer", "name")
      .sort({ createdAt: -1 });

    // if data not found
    if (!jsonData || jsonData.length === 0) {
      return next(new AppError("No orders found for the specified criteria", 404));
    }

    // preparing data
    let srNo = 0;
    let csvData = [];
      let csvFields = [
    "Sr No",
    "Order ID",
    "Order Date",
    "Customer Name",
    "Mobile Number",
    "Village",
    "Taluka",
    "District",
    "State",
    "Plant Name",
    "Plant Subtype",
    "Number of Plants",
    "Rate per Plant",
    "Total Amount",
    "Order Status",
    "Payment Status",
    "Total Paid Amount",
    "Balance Amount",
    "Sales Person",
    "Sales Person Mobile",
    "Dealer Name",
    "Booking Slot",
    "Delivery Period",
    "Order Type",
    "Payment Count",
    "Payment Number",
    "Payment Amount",
    "Payment Mode",
    "Payment Status",
    "Payment Date",
    "Bank Name",
    "Payment Remark",
    "Remarks",
    "Order For Name",
    "Order For Mobile",
    "Order For Address"
  ];

    // Process data synchronously to avoid Promise.all issues
    jsonData.forEach((obj) => {
      try {
        // Calculate payment details
        const totalPaidAmount = obj.payment && obj.payment.length > 0 
          ? obj.payment.reduce((sum, payment) => sum + (payment.paidAmount || 0), 0)
          : 0;
        
        const totalAmount = (obj.rate || 0) * (obj.numberOfPlants || 0);
        const balanceAmount = totalAmount - totalPaidAmount;
        
        // Enhanced payment details for multiple payments
        const paymentCount = obj.payment ? obj.payment.length : 0;
        
        // Format delivery period - bookingSlot is just an ID, not populated
        const deliveryPeriod = obj.bookingSlot ? `Slot ID: ${obj.bookingSlot}` : 'N/A';

        // Determine order type
        const orderType = obj.dealerOrder ? 'Dealer Order' : 'Farmer Order';

        // Base order data
        const baseOrderData = {
          "Sr No": ++srNo,
          "Order ID": obj.orderId || obj._id,
          "Order Date": obj.createdAt ? new Date(obj.createdAt).toLocaleDateString('en-IN') : 'N/A',
          "Customer Name": obj.farmer?.name || obj.name || 'N/A',
          "Mobile Number": obj.farmer?.mobileNumber || obj.mobileNumber || 'N/A',
          "Village": obj.farmer?.village || obj.village || 'N/A',
          "Taluka": obj.farmer?.taluka || obj.taluka || 'N/A',
          "District": obj.farmer?.district || obj.district || 'N/A',
          "State": obj.farmer?.state || obj.state || 'N/A',
          "Plant Name": obj.plantName?.name || 'N/A',
          "Plant Subtype": obj.plantSubtype ? 
            (obj.plantName?.subtypes?.find(subtype => subtype._id.toString() === obj.plantSubtype.toString())?.name || 'N/A') 
            : 'N/A',
          "Number of Plants": obj.numberOfPlants || 0,
          "Rate per Plant": obj.rate || 0,
          "Total Amount": totalAmount,
          "Order Status": obj.orderStatus || 'N/A',
          "Payment Status": obj.orderPaymentStatus || 'N/A',
          "Total Paid Amount": totalPaidAmount,
          "Balance Amount": balanceAmount,
          "Sales Person": obj.salesPerson?.name || 'N/A',
          "Sales Person Mobile": obj.salesPerson?.phoneNumber || 'N/A',
          "Dealer Name": obj.dealer?.name || 'N/A',
          "Booking Slot": obj.bookingSlot || 'N/A',
          "Delivery Period": deliveryPeriod,
          "Order Type": orderType,
          "Payment Count": paymentCount,
          "Remarks": obj.orderRemarks && obj.orderRemarks.length > 0 
            ? obj.orderRemarks.join('; ') 
            : 'N/A',
          "Order For Name": obj.orderFor?.name || 'N/A',
          "Order For Mobile": obj.orderFor?.mobileNumber || 'N/A',
          "Order For Address": obj.orderFor?.address || 'N/A'
        };

        // Handle multiple payments - create separate rows for each payment
        if (obj.payment && obj.payment.length > 0) {
          obj.payment.forEach((payment, paymentIndex) => {
            const paymentData = {
              ...baseOrderData,
              "Payment Number": paymentIndex + 1,
              "Payment Amount": payment.paidAmount || 0,
              "Payment Mode": payment.modeOfPayment || 'N/A',
              "Payment Status": payment.paymentStatus || 'PENDING',
              "Payment Date": payment.paymentDate ? new Date(payment.paymentDate).toLocaleDateString('en-IN') : 'N/A',
              "Bank Name": payment.bankName || 'N/A',
              "Payment Remark": payment.remark || 'N/A'
            };
            csvData.push(paymentData);
          });
        } else {
          // No payments - add single row with empty payment fields
          const noPaymentData = {
            ...baseOrderData,
            "Payment Number": 'N/A',
            "Payment Amount": 0,
            "Payment Mode": 'N/A',
            "Payment Status": 'N/A',
            "Payment Date": 'N/A',
            "Bank Name": 'N/A',
            "Payment Remark": 'N/A'
          };
          csvData.push(noPaymentData);
        }
      } catch (error) {
        console.error("Error processing order:", obj._id, error);
        // Continue with next order
      }
    });

  // Generate filename with date range
  const filename = `orders_export_${startDate ? startDate.split('T')[0] : 'all'}_${endDate ? endDate.split('T')[0] : 'data'}.csv`;

  // sending response
  const csvParse = new CsvParser({ fields: csvFields });
  const csvDataParsed = csvParse.parse(csvData);
  
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.status(200).end(csvDataParsed);
  } catch (error) {
    console.error("CSV Export - Error:", error);
    return next(new AppError("Error generating CSV: " + error.message, 500));
  }
});

const getOrders = getAll(Order, "Order");
const createOrder = createOne(Order, "Order");
const updateOrder = updateOne(Order, "Order", [
  "bookingSlot",
  "numberOfPlants",
  "quantity", // Alias for numberOfPlants
  "rate",
  "orderPaymentStatus",
  "notes",
  "farmReadyDate",
  "orderStatus",
  "orderRemarks",
  "farmReadyDateChangeReason",
  "farmReadyDateChangeNotes",
  "deliveryDate", // Specific delivery date
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
  console.log("Request file:", req.file);

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

  // Handle uploaded screenshot file with Cloudinary
  let screenshotUrl = null;
  if (req.file) {
    try {
      const { uploadImageToCloudinary } = await import('../utils/cloudinaryUtils.js');
      const uploadResult = await uploadImageToCloudinary(
        req.file.buffer,
        'nursery-orders/payments'
      );
      
      if (uploadResult.success) {
        screenshotUrl = uploadResult.url;
        console.log("Screenshot uploaded to Cloudinary:", screenshotUrl);
      } else {
        console.error("Failed to upload screenshot to Cloudinary:", uploadResult.error);
      }
    } catch (error) {
      console.error("Error uploading screenshot to Cloudinary:", error);
    }
  }

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

    // Set payment status based on payment type and user role
    const userRole = req.user?.role;
    let finalPaymentStatus = "PENDING"; // Default to PENDING for new payments
    
    // For OFFICE_ADMIN, always keep payment status as PENDING
    if (userRole === "OFFICE_ADMIN") {
      finalPaymentStatus = "PENDING";
      console.log("OFFICE_ADMIN payment - forcing status to PENDING");
    } else if (paymentStatus && (paymentStatus === "COLLECTED" || paymentStatus === "PENDING")) {
      // Use the requested payment status if provided, otherwise default to PENDING
      finalPaymentStatus = paymentStatus;
      console.log("Using requested payment status:", finalPaymentStatus);
    } else {
      console.log("Using default payment status: PENDING");
    }

    console.log("Payment details:");
    console.log("- Amount:", amount);
    console.log("- Requested Status:", paymentStatus);
    console.log("- Final Status:", finalPaymentStatus);
    console.log("- User Role:", userRole);
    console.log("- Is wallet payment:", isWalletPayment ? "Yes" : "No");
    console.log("- Mode:", modeOfPayment);
    console.log("- Payment will be saved with status:", finalPaymentStatus);

    // Create the payment object
    const newPayment = {
      paidAmount: amount,
      paymentStatus: finalPaymentStatus, // Use the determined status
      paymentDate,
      bankName,
      receiptPhoto: screenshotUrl ? [screenshotUrl] : (receiptPhoto || []), // Use uploaded screenshot or existing receiptPhoto
      modeOfPayment,
      isWalletPayment,
    };
    
    console.log("Created payment object with status:", newPayment.paymentStatus);

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
        // PENDING and COLLECTED payments should impact wallet balance
        if (isWalletPayment && (finalPaymentStatus === "PENDING" || finalPaymentStatus === "COLLECTED")) {
          // Deduct from wallet (negative amount) - when dealer pays from wallet (pending or collected)
          walletAmount = -amount;
          description = `Wallet payment ${finalPaymentStatus.toLowerCase()} for Order #${order._id} - ${farmerInfo}`;
          console.log(`This is a ${finalPaymentStatus.toLowerCase()} wallet payment, deducting amount from wallet`);
        } else if (order.dealerOrder && finalPaymentStatus === "COLLECTED" && !isWalletPayment) {
          // Add to wallet (positive amount) - when payment is collected from dealer (not wallet)
          walletAmount = amount;
          description = `Payment collected for Order #${order._id} via ${modeOfPayment} - ${farmerInfo}`;
          console.log("This is a collected payment for dealer order, adding to wallet");
        } else if (order.dealerOrder && isWalletPayment && (finalPaymentStatus === "PENDING" || finalPaymentStatus === "COLLECTED")) {
          // Special case: Dealer order with wallet payment (pending or collected)
          // This means the dealer is using their wallet balance to pay
          walletAmount = -amount;
          description = `Wallet payment ${finalPaymentStatus.toLowerCase()} for Dealer Order #${order._id} - ${farmerInfo}`;
          console.log(`This is a dealer wallet payment being ${finalPaymentStatus.toLowerCase()}`);
        } else {
          // Non-wallet payments or other statuses should NOT impact wallet balance
          walletAmount = 0;
          description = `Payment recorded (no wallet impact) for Order #${order._id} - ${farmerInfo}`;
          console.log("This payment has no wallet impact");
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
      if (isWalletPayment && (paymentStatus === "PENDING" || paymentStatus === "COLLECTED")) {
        // Deduct from wallet (negative amount) - for both pending and collected wallet payments
        walletAmount = -amount;
        description = `Wallet payment ${paymentStatus.toLowerCase()} for Order #${order._id} - ${farmerInfo}`;
      } else if (order.dealerOrder && paymentStatus === "COLLECTED" && !isWalletPayment) {
        // Add to wallet (positive amount) - when payment is collected from dealer (not wallet)
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

    // Debug: Log order details (can be removed in production)
    console.log('Order found for payment status update:', {
      orderId: order._id,
      orderNumber: order.orderId,
      dealerOrder: order.dealerOrder,
      hasDealer: !!order.dealer,
      hasSalesPerson: !!order.salesPerson,
      hasFarmer: !!order.farmer
    });

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

    // Prevent OFFICE_ADMIN from changing payment status to COLLECTED
    const userRole = req.user?.role;
    if (userRole === "OFFICE_ADMIN" && paymentStatus === "COLLECTED") {
      return res.status(403).json({
        message: "OFFICE_ADMIN cannot change payment status to COLLECTED. Contact an Accountant or Super Admin.",
      });
    }

    // Handle wallet payment status changes (PRIORITY: Wallet payments take precedence)
    if (payment.isWalletPayment) {
      console.log('Processing wallet payment status change');
      console.log('Current status:', payment.paymentStatus, 'New status:', paymentStatus);
      console.log('Order is dealer order:', order.dealerOrder);
      console.log('Payment is wallet payment:', payment.isWalletPayment);
      console.log('Order dealer field:', order.dealer);
      console.log('Order sales person field:', order.salesPerson);
      
      // Determine the dealer for wallet operations
      let dealerForWallet = null;
      
      if (order.dealer) {
        // Use the order's dealer field if available
        dealerForWallet = order.dealer;
        console.log('Using order dealer for wallet operations:', dealerForWallet);
      } else if (order.salesPerson) {
        // Check if sales person is a dealer
        const salesPerson = await User.findById(order.salesPerson);
        if (salesPerson && salesPerson.jobTitle === 'DEALER') {
          dealerForWallet = order.salesPerson;
          console.log('Using sales person as dealer for wallet operations:', dealerForWallet);
        }
      }
      
      if (!dealerForWallet) {
        console.warn('Payment marked as wallet payment but no dealer found. Skipping wallet operations.');
        console.log('This may indicate a data inconsistency. Payment will be updated without wallet operations.');
        // Continue with payment status update but skip wallet operations
      } else {
      
      // For wallet payments:
      // - When payment is rejected, credit back to wallet (add money)
      // - When payment is pending or collected, debit from wallet (subtract money)
      // - Since we now deduct on PENDING, we need to handle status changes carefully
      
      try {
        if (payment.paymentStatus === "COLLECTED" && paymentStatus === "REJECTED") {
          // Collected payment was rejected, credit back to wallet
          await updateDealerWalletBalance(dealerForWallet, amount, `Payment rejected - credited back to wallet for Order #${order._id}`, req.user?._id);
        } else if (payment.paymentStatus === "COLLECTED" && paymentStatus === "PENDING") {
          // Collected payment is now pending, but since we deduct on pending too, no change needed
          // Just update the description in transaction history
          console.log("Payment status changed from COLLECTED to PENDING - no wallet impact (both deduct from wallet)");
        } else if (payment.paymentStatus === "REJECTED" && paymentStatus === "COLLECTED") {
          // Rejected payment is now collected, debit from wallet
          await updateDealerWalletBalance(dealerForWallet, -amount, `Payment collected - debited from wallet for Order #${order._id}`, req.user?._id);
        } else if (payment.paymentStatus === "REJECTED" && paymentStatus === "PENDING") {
          // Rejected payment is now pending, debit from wallet
          await updateDealerWalletBalance(dealerForWallet, -amount, `Payment pending - debited from wallet for Order #${order._id}`, req.user?._id);
        } else if (payment.paymentStatus === "PENDING" && paymentStatus === "COLLECTED") {
          // Pending payment is now collected, but since we deduct on both, no change needed
          console.log("Payment status changed from PENDING to COLLECTED - no wallet impact (both deduct from wallet)");
        } else if (payment.paymentStatus === "PENDING" && paymentStatus === "REJECTED") {
          // Pending payment is now rejected, credit back to wallet
          await updateDealerWalletBalance(dealerForWallet, amount, `Payment rejected - credited back to wallet for Order #${order._id}`, req.user?._id);
        }
      } catch (walletError) {
        console.error('Error updating dealer wallet:', walletError);
        return res.status(500).json({
          success: false,
          message: "Error updating dealer wallet",
          error: walletError.message,
        });
      }
      } // Close the else block for dealer validation
    }
    // Handle bulk order (dealer order) payment status changes (ONLY if not a wallet payment)
    else if (order.dealerOrder && order.dealer && !payment.isWalletPayment) {
      console.log('Processing bulk order payment status change');
      console.log('Current status:', payment.paymentStatus, 'New status:', paymentStatus);
      console.log('Order is dealer order:', order.dealerOrder);
      console.log('Payment is wallet payment:', payment.isWalletPayment);
      console.log('Order dealer field:', order.dealer);
      
      // Validate that we have a dealer for wallet operations
      if (!order.dealer) {
        console.error('Cannot process bulk order payment: Order has no dealer field');
        return res.status(400).json({
          success: false,
          message: "Cannot process bulk order payment: Order has no associated dealer",
        });
      }
      
      // For bulk orders (dealer orders):
      // - When payment is collected, credit to wallet (add money)
      // - When payment is rejected, debit from wallet (subtract money)
      
      try {
        if (payment.paymentStatus !== "COLLECTED" && paymentStatus === "COLLECTED") {
          // Payment is now collected, credit to wallet
          await updateDealerWalletBalance(order.dealer, amount, `Payment collected for bulk order - credited to wallet for Order #${order._id}`, req.user?._id);
        } else if (payment.paymentStatus === "COLLECTED" && paymentStatus === "REJECTED") {
          // Collected payment is now rejected, debit from wallet
          await updateDealerWalletBalance(order.dealer, -amount, `Payment rejected for bulk order - debited from wallet for Order #${order._id}`, req.user?._id);
        } else if (payment.paymentStatus === "COLLECTED" && paymentStatus === "PENDING") {
          // Collected payment is now pending, debit from wallet
          await updateDealerWalletBalance(order.dealer, -amount, `Payment changed to pending for bulk order - debited from wallet for Order #${order._id}`, req.user?._id);
        } else if (payment.paymentStatus === "REJECTED" && paymentStatus === "COLLECTED") {
          // Rejected payment is now collected, credit to wallet
          await updateDealerWalletBalance(order.dealer, amount, `Payment collected for bulk order - credited to wallet for Order #${order._id}`, req.user?._id);
        }
      } catch (walletError) {
        console.error('Error updating dealer wallet for bulk order:', walletError);
        return res.status(500).json({
          success: false,
          message: "Error updating dealer wallet for bulk order",
          error: walletError.message,
        });
      }
    }

    payment.paymentStatus = paymentStatus;
    await order.save();

    // Send push notification based on payment status change
    try {
      let userToNotify = null;
      
      // Determine who to notify based on order type
      if (order.dealer) {
        // For dealer orders, notify the dealer
        userToNotify = await User.findById(order.dealer);
        console.log(`📱 Dealer order detected. Dealer ID: ${order.dealer}`);
      } else if (order.salesPerson) {
        // For farmer orders, notify the sales person
        userToNotify = await User.findById(order.salesPerson);
        console.log(`📱 Farmer order detected. Sales Person ID: ${order.salesPerson}`);
      }

      console.log(`📱 User to notify:`, {
        name: userToNotify?.name,
        phone: userToNotify?.phoneNumber,
        hasPushToken: !!userToNotify?.expoPushToken,
        pushToken: userToNotify?.expoPushToken ? `${userToNotify.expoPushToken.substring(0, 30)}...` : 'NONE'
      });

      if (userToNotify && userToNotify.expoPushToken) {
        const orderId = order.orderId || order._id;
        const pushToken = userToNotify.expoPushToken;

        console.log(`📤 Sending ${paymentStatus} notification for Order #${orderId}, Amount: ₹${amount}`);

        // Send notification based on new payment status
        if (paymentStatus === 'COLLECTED') {
          const result = await sendPaymentCollectedNotification(pushToken, orderId, amount);
          console.log(`✅ Payment collected notification sent for Order #${orderId}`, result);
        } else if (paymentStatus === 'REJECTED') {
          const result = await sendPaymentRejectedNotification(pushToken, orderId, amount, remark || '');
          console.log(`❌ Payment rejected notification sent for Order #${orderId}`, result);
        } else if (paymentStatus === 'PENDING') {
          const result = await sendPaymentPendingNotification(pushToken, orderId, amount);
          console.log(`⏳ Payment pending notification sent for Order #${orderId}`, result);
        }
      } else {
        console.log('⚠️ No push token found for user, skipping notification');
        console.log('   User needs to open the mobile app to register for notifications');
      }
    } catch (notificationError) {
      // Don't fail the request if notification fails
      console.error('❌ Error sending push notification:', notificationError);
      console.error('   Stack:', notificationError.stack);
    }

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
      },
      {
        $lookup: {
          from: "users",
          localField: "dispatchHistory.processedBy",
          foreignField: "_id",
          as: "dispatchHistoryUsers",
        },
      },
      {
        $lookup: {
          from: "dispatches",
          localField: "dispatchHistory.dispatchId",
          foreignField: "_id",
          as: "dispatchHistoryDispatches",
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
          dispatchHistory: 1,
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
          dispatchHistory: {
            $map: {
              input: { $ifNull: ["$dispatchHistory", []] },
              as: "dispatchEntry",
              in: {
                date: "$$dispatchEntry.date",
                quantity: "$$dispatchEntry.quantity",
                remainingAfterDispatch: "$$dispatchEntry.remainingAfterDispatch",
                dispatchId: "$$dispatchEntry.dispatchId",
                dispatch: {
                  $let: {
                    vars: {
                      dispatchIdStr: { $toString: "$$dispatchEntry.dispatchId" }
                    },
                    in: {
                      $arrayElemAt: [
                        {
                          $filter: {
                            input: "$dispatchHistoryDispatches",
                            as: "dispatch",
                            cond: { $eq: [{ $toString: "$$dispatch._id" }, "$$dispatchIdStr"] }
                          }
                        },
                        0
                      ]
                    }
                  }
                },
                processedBy: {
                  $cond: {
                    if: "$$dispatchEntry.processedBy",
                    then: {
                      $let: {
                        vars: {
                          userId: { $toString: "$$dispatchEntry.processedBy" }
                        },
                        in: {
                          $let: {
                            vars: {
                              userData: {
                                $arrayElemAt: [
                                  {
                                    $filter: {
                                      input: "$dispatchHistoryUsers",
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
                                { _id: "$$dispatchEntry.processedBy" }
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
          // Add orderFor field if present
          orderFor: 1,
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
        screenshots: 1,
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

// Get orders to be dispatched based on delivery date range
const getOrdersToBeDispatched = catchAsync(async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    
    // Validate date parameters
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "Start date and end date are required",
        data: null
      });
    }

    // Parse dates
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0); // Set to start of day
    
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999); // Set to end of day
    
    // Validate date format
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format. Please use YYYY-MM-DD format",
        data: null
      });
    }

    // Find orders with delivery date within the date range
    const orders = await Order.aggregate([
      {
        $match: {
          deliveryDate: {
            $gte: start,
            $lte: end
          }
          // Removed status filter - now shows all statuses
        }
      },
      {
        $lookup: {
          from: "plantslots",
          localField: "bookingSlot",
          foreignField: "subtypeSlots._id",
          as: "slotData"
        }
      },
      {
        $unwind: {
          path: "$slotData",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $unwind: {
          path: "$slotData.subtypeSlots",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmerData"
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "salesPerson",
          foreignField: "_id",
          as: "salesPersonData"
        }
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantName",
          foreignField: "_id",
          as: "plantData"
        }
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantSubtype",
          foreignField: "subtypes._id",
          as: "subtypeData"
        }
      },
      {
        $unwind: {
          path: "$farmerData",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $unwind: {
          path: "$salesPersonData",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $unwind: {
          path: "$plantData",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $unwind: {
          path: "$subtypeData",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $addFields: {
          matchedSubtype: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$subtypeData.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$plantSubtype"] }
                }
              },
              0
            ]
          }
        }
      },
      {
        $project: {
          _id: 1,
          orderId: 1,
          numberOfPlants: 1,
          remainingPlants: 1,
          rate: 1,
          orderStatus: 1,
          orderPaymentStatus: 1,
          deliveryDate: 1,
          farmReadyDate: 1,
          createdAt: 1,
          updatedAt: 1,
          farmer: {
            _id: "$farmerData._id",
            name: "$farmerData.name",
            mobileNumber: "$farmerData.mobileNumber",
            village: "$farmerData.village",
            taluka: "$farmerData.taluka",
            district: "$farmerData.district",
            state: "$farmerData.state"
          },
          salesPerson: {
            _id: "$salesPersonData._id",
            name: "$salesPersonData.name",
            phoneNumber: "$salesPersonData.phoneNumber"
          },
          plantName: "$plantData.name",
          plantType: {
            _id: "$plantData._id",
            id: "$plantData._id",
            name: "$plantData.name"
          },
          plantSubtype: {
            _id: "$matchedSubtype._id",
            id: "$matchedSubtype._id", 
            name: "$matchedSubtype.name"
          },
          slotInfo: {
            startDay: "$slotData.subtypeSlots.startDay",
            endDay: "$slotData.subtypeSlots.endDay",
            month: "$slotData.subtypeSlots.month",
            totalPlants: "$slotData.subtypeSlots.totalPlants",
            totalBookedPlants: "$slotData.subtypeSlots.totalBookedPlants"
          },
          totalAmount: { $multiply: ["$numberOfPlants", "$rate"] }
        }
      },
      {
        $sort: { createdAt: -1 }
      }
    ]);

    return res.status(200).json({
      success: true,
      message: "Orders to be dispatched retrieved successfully",
      data: {
        orders,
        totalCount: orders.length,
        dateRange: {
          startDate,
          endDate
        }
      }
    });

  } catch (error) {
    console.error("Error getting orders to be dispatched:", error);
    return res.status(500).json({
      success: false,
      message: "Error retrieving orders to be dispatched",
      error: error.message
    });
  }
});

// Get all cavities from all orders
const getAllCavitiesFromOrders = catchAsync(async (req, res, next) => {
  try {
    // Aggregate to get all unique cavity IDs from orders
    const cavitiesFromOrders = await Order.aggregate([
      {
        $match: {
          cavity: { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: "$cavity",
          orderCount: { $sum: 1 },
          totalPlants: { $sum: "$numberOfPlants" }
        }
      },
      {
        $lookup: {
          from: "trays",
          localField: "_id",
          foreignField: "_id",
          as: "trayDetails"
        }
      },
      {
        $unwind: {
          path: "$trayDetails",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $project: {
          _id: 0,
          cavityId: "$_id",
          cavityNumber: "$trayDetails.cavity",
          cavityName: "$trayDetails.name",
          numberPerCrate: "$trayDetails.numberPerCrate",
          isActive: "$trayDetails.isActive",
          orderCount: 1,
          totalPlants: 1
        }
      },
      {
        $sort: { cavityNumber: 1 }
      }
    ]);

    return res.status(200).json({
      success: true,
      data: {
        cavities: cavitiesFromOrders,
        totalCavities: cavitiesFromOrders.length,
        summary: {
          totalOrders: cavitiesFromOrders.reduce((sum, c) => sum + c.orderCount, 0),
          totalPlants: cavitiesFromOrders.reduce((sum, c) => sum + c.totalPlants, 0)
        }
      }
    });
  } catch (error) {
    console.error("Error fetching cavities from orders:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while fetching cavities.",
      error: error.message
    });
  }
});

// Order Bucketing - Hierarchical grouping of orders
const getOrderBucketing = catchAsync(async (req, res, next) => {
  try {
    const { level, startDate, endDate, status, plantId, subtypeId, year, month, day } = req.query;

    // Validate level parameter
    const levelNum = parseInt(level);
    if (!levelNum || levelNum < 1 || levelNum > 5) {
      return res.status(400).json({
        success: false,
        message: "Level must be between 1 and 5"
      });
    }

    // Build match filter
    const matchFilter = {};

    // Date filter
    if (startDate || endDate) {
      matchFilter.orderBookingDate = {};
      if (startDate) {
        matchFilter.orderBookingDate.$gte = new Date(startDate);
      }
      if (endDate) {
        matchFilter.orderBookingDate.$lte = new Date(endDate);
      }
    }

    // Status filter
    if (status) {
      matchFilter.orderStatus = status;
    }

    // Plant filter
    if (plantId) {
      matchFilter.plantName = new mongoose.Types.ObjectId(plantId);
    }

    // Subtype filter
    if (subtypeId) {
      matchFilter.plantSubtype = new mongoose.Types.ObjectId(subtypeId);
    }

    // Year filter
    if (year) {
      const yearNum = parseInt(year);
      matchFilter.orderBookingDate = matchFilter.orderBookingDate || {};
      matchFilter.orderBookingDate.$gte = new Date(`${yearNum}-01-01`);
      matchFilter.orderBookingDate.$lte = new Date(`${yearNum}-12-31T23:59:59.999Z`);
    }

    // Month filter
    if (month && year) {
      const yearNum = parseInt(year);
      const monthNum = parseInt(month);
      matchFilter.orderBookingDate = matchFilter.orderBookingDate || {};
      matchFilter.orderBookingDate.$gte = new Date(yearNum, monthNum - 1, 1);
      matchFilter.orderBookingDate.$lte = new Date(yearNum, monthNum, 0, 23, 59, 59, 999);
    }

    // Day filter
    if (day && month && year) {
      const yearNum = parseInt(year);
      const monthNum = parseInt(month);
      const dayNum = parseInt(day);
      matchFilter.orderBookingDate = matchFilter.orderBookingDate || {};
      matchFilter.orderBookingDate.$gte = new Date(yearNum, monthNum - 1, dayNum);
      matchFilter.orderBookingDate.$lte = new Date(yearNum, monthNum - 1, dayNum, 23, 59, 59, 999);
    }

    let pipeline = [{ $match: matchFilter }];

    // Add lookup for plant information
    pipeline.push({
      $lookup: {
        from: "plantcms",
        localField: "plantName",
        foreignField: "_id",
        as: "plantDetails"
      }
    });

    // Add lookup for subtype information
    pipeline.push({
      $lookup: {
        from: "plantcms",
        let: { plantId: "$plantName", subtypeId: "$plantSubtype" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$plantId"] } } },
          { $unwind: "$subtypes" },
          { $match: { $expr: { $eq: ["$subtypes._id", "$$subtypeId"] } } },
          { $project: { subtypeName: "$subtypes.name" } }
        ],
        as: "subtypeDetails"
      }
    });

    // Group by level
    const groupStage = {
      totalOrders: { $sum: 1 },
      totalPlants: { $sum: "$numberOfPlants" },
      totalAmount: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
      plantId: { $first: "$plantName" },
      plantName: { $first: { $arrayElemAt: ["$plantDetails.name", 0] } }
    };

    // Level 1: Group by plant
    if (levelNum === 1) {
      groupStage._id = "$plantName";
    }
    // Level 2: Group by plant + subtype
    else if (levelNum === 2) {
      groupStage._id = {
        plantId: "$plantName",
        subtypeId: "$plantSubtype"
      };
      groupStage.subtypeId = { $first: "$plantSubtype" };
      groupStage.subtypeName = { $first: { $arrayElemAt: ["$subtypeDetails.subtypeName", 0] } };
    }
    // Level 3: Group by plant + subtype + month
    else if (levelNum === 3) {
      groupStage._id = {
        plantId: "$plantName",
        subtypeId: "$plantSubtype",
        year: { $year: "$orderBookingDate" },
        month: { $month: "$orderBookingDate" }
      };
      groupStage.subtypeId = { $first: "$plantSubtype" };
      groupStage.subtypeName = { $first: { $arrayElemAt: ["$subtypeDetails.subtypeName", 0] } };
      groupStage.year = { $first: { $year: "$orderBookingDate" } };
      groupStage.month = { $first: { $month: "$orderBookingDate" } };
    }
    // Level 4: Group by plant + subtype + month + day
    else if (levelNum === 4) {
      groupStage._id = {
        plantId: "$plantName",
        subtypeId: "$plantSubtype",
        year: { $year: "$orderBookingDate" },
        month: { $month: "$orderBookingDate" },
        day: { $dayOfMonth: "$orderBookingDate" }
      };
      groupStage.subtypeId = { $first: "$plantSubtype" };
      groupStage.subtypeName = { $first: { $arrayElemAt: ["$subtypeDetails.subtypeName", 0] } };
      groupStage.year = { $first: { $year: "$orderBookingDate" } };
      groupStage.month = { $first: { $month: "$orderBookingDate" } };
      groupStage.day = { $first: { $dayOfMonth: "$orderBookingDate" } };
    }
    // Level 5: Individual orders
    else if (levelNum === 5) {
      groupStage._id = "$_id";
      groupStage.orderId = { $first: "$_id" };
      groupStage.numberOfPlants = { $first: "$numberOfPlants" };
      groupStage.rate = { $first: "$rate" };
      groupStage.orderStatus = { $first: "$orderStatus" };
      groupStage.farmer = { $first: "$farmer" };
      groupStage.orderBookingDate = { $first: "$orderBookingDate" };
      groupStage.deliveryDate = { $first: "$deliveryDate" };
    }

    pipeline.push({ $group: groupStage });

    // Format output based on level
    const projectStage = {
      _id: 0,
      totalOrders: 1,
      totalPlants: 1,
      totalAmount: 1,
      plantId: 1,
      plantName: 1
    };

    if (levelNum >= 2) {
      projectStage.subtypeId = 1;
      projectStage.subtypeName = 1;
    }

    if (levelNum >= 3) {
      projectStage.year = 1;
      projectStage.month = 1;
      projectStage.monthName = {
        $let: {
          vars: {
            months: ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
          },
          in: { $arrayElemAt: ["$$months", "$month"] }
        }
      };
      projectStage.monthKey = { $concat: [{ $toString: "$year" }, "-", { $toString: "$month" }] };
    }

    if (levelNum >= 4) {
      projectStage.day = 1;
      projectStage.dayName = {
        $concat: [
          { $toString: "$day" },
          " ",
          {
            $let: {
              vars: {
                months: ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
              },
              in: { $arrayElemAt: ["$$months", "$month"] }
            }
          },
          " ",
          { $toString: "$year" }
        ]
      };
      projectStage.dayKey = { $concat: [{ $toString: "$year" }, "-", { $toString: "$month" }, "-", { $toString: "$day" }] };
    }

    if (levelNum === 5) {
      projectStage.orderId = 1;
      projectStage.numberOfPlants = 1;
      projectStage.rate = 1;
      projectStage.orderStatus = 1;
      projectStage.farmer = 1;
      projectStage.orderBookingDate = 1;
      projectStage.deliveryDate = 1;
    }

    pipeline.push({ $project: projectStage });

    // Sort results
    const sortStage = {};
    if (levelNum === 1) {
      sortStage.plantName = 1;
    } else if (levelNum === 2) {
      sortStage.subtypeName = 1;
    } else if (levelNum === 3) {
      sortStage.year = 1;
      sortStage.month = 1;
    } else if (levelNum === 4) {
      sortStage.year = 1;
      sortStage.month = 1;
      sortStage.day = 1;
    } else {
      sortStage.orderBookingDate = -1;
    }
    pipeline.push({ $sort: sortStage });

    const results = await Order.aggregate(pipeline);

    return res.status(200).json({
      success: true,
      data: results
    });
  } catch (error) {
    console.error("Error in getOrderBucketing:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while fetching bucketing data.",
      error: error.message
    });
  }
});

// Salesmen Bucketing - Hierarchical grouping of orders by salesperson and location
const getSalesmenBucketing = catchAsync(async (req, res, next) => {
  try {
    const { level, startDate, endDate, status, salesPersonId, district, taluka, village } = req.query;

    // Validate level parameter
    const levelNum = parseInt(level);
    if (!levelNum || levelNum < 1 || levelNum > 5) {
      return res.status(400).json({
        success: false,
        message: "Level must be between 1 and 5"
      });
    }

    // Build match filter
    const matchFilter = {};

    // Date filter
    if (startDate || endDate) {
      matchFilter.orderBookingDate = {};
      if (startDate) {
        matchFilter.orderBookingDate.$gte = new Date(startDate);
      }
      if (endDate) {
        matchFilter.orderBookingDate.$lte = new Date(endDate);
      }
    }

    // Status filter
    if (status) {
      matchFilter.orderStatus = status;
    }

    // Salesperson filter
    if (salesPersonId) {
      matchFilter.salesPerson = new mongoose.Types.ObjectId(salesPersonId);
    }

    let pipeline = [{ $match: matchFilter }];

    // Add lookup for salesperson (User) information
    pipeline.push({
      $lookup: {
        from: "users",
        localField: "salesPerson",
        foreignField: "_id",
        as: "salesPersonDetails"
      }
    });

    // Add lookup for farmer information (for location data)
    pipeline.push({
      $lookup: {
        from: "farmers",
        localField: "farmer",
        foreignField: "_id",
        as: "farmerDetails"
      }
    });

    // Unwind farmer details (assuming one farmer per order)
    pipeline.push({
      $unwind: {
        path: "$farmerDetails",
        preserveNullAndEmptyArrays: true // Handle dealer orders that might not have a farmer
      }
    });

    // Add location filters after lookup (farmerDetails fields are now available)
    const locationFilter = {};
    if (district) {
      locationFilter["farmerDetails.district"] = district;
    }
    if (taluka) {
      locationFilter["farmerDetails.taluka"] = taluka;
    }
    if (village) {
      locationFilter["farmerDetails.village"] = village;
    }
    if (Object.keys(locationFilter).length > 0) {
      pipeline.push({ $match: locationFilter });
    }

    // Group by level
    const groupStage = {
      totalOrders: { $sum: 1 },
      totalPlants: { $sum: "$numberOfPlants" },
      totalAmount: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
      salesPersonId: { $first: "$salesPerson" },
      salesPersonName: { $first: { $arrayElemAt: ["$salesPersonDetails.name", 0] } },
      salesPersonPhone: { $first: { $arrayElemAt: ["$salesPersonDetails.phoneNumber", 0] } }
    };

    // Level 1: Group by salesperson
    if (levelNum === 1) {
      groupStage._id = "$salesPerson";
    }
    // Level 2: Group by salesperson + district
    else if (levelNum === 2) {
      groupStage._id = {
        salesPersonId: "$salesPerson",
        district: "$farmerDetails.district"
      };
      groupStage.district = { $first: "$farmerDetails.district" };
      groupStage.districtName = { $first: "$farmerDetails.districtName" };
    }
    // Level 3: Group by salesperson + district + taluka
    else if (levelNum === 3) {
      groupStage._id = {
        salesPersonId: "$salesPerson",
        district: "$farmerDetails.district",
        taluka: "$farmerDetails.taluka"
      };
      groupStage.district = { $first: "$farmerDetails.district" };
      groupStage.districtName = { $first: "$farmerDetails.districtName" };
      groupStage.taluka = { $first: "$farmerDetails.taluka" };
      groupStage.talukaName = { $first: "$farmerDetails.talukaName" };
    }
    // Level 4: Group by salesperson + district + taluka + village
    else if (levelNum === 4) {
      groupStage._id = {
        salesPersonId: "$salesPerson",
        district: "$farmerDetails.district",
        taluka: "$farmerDetails.taluka",
        village: "$farmerDetails.village"
      };
      groupStage.district = { $first: "$farmerDetails.district" };
      groupStage.districtName = { $first: "$farmerDetails.districtName" };
      groupStage.taluka = { $first: "$farmerDetails.taluka" };
      groupStage.talukaName = { $first: "$farmerDetails.talukaName" };
      groupStage.village = { $first: "$farmerDetails.village" };
    }
    // Level 5: Individual orders
    else if (levelNum === 5) {
      groupStage._id = "$_id";
      groupStage.orderId = { $first: "$_id" };
      groupStage.numberOfPlants = { $first: "$numberOfPlants" };
      groupStage.rate = { $first: "$rate" };
      groupStage.orderStatus = { $first: "$orderStatus" };
      groupStage.farmer = { $first: "$farmer" };
      groupStage.orderBookingDate = { $first: "$orderBookingDate" };
      groupStage.deliveryDate = { $first: "$deliveryDate" };
      groupStage.district = { $first: "$farmerDetails.district" };
      groupStage.districtName = { $first: "$farmerDetails.districtName" };
      groupStage.taluka = { $first: "$farmerDetails.taluka" };
      groupStage.talukaName = { $first: "$farmerDetails.talukaName" };
      groupStage.village = { $first: "$farmerDetails.village" };
    }

    pipeline.push({ $group: groupStage });

    // Format output based on level
    const projectStage = {
      _id: 0,
      totalOrders: 1,
      totalPlants: 1,
      totalAmount: 1,
      salesPersonId: 1,
      salesPersonName: 1,
      salesPersonPhone: 1
    };

    if (levelNum >= 2) {
      projectStage.district = 1;
      projectStage.districtName = 1;
    }

    if (levelNum >= 3) {
      projectStage.taluka = 1;
      projectStage.talukaName = 1;
    }

    if (levelNum >= 4) {
      projectStage.village = 1;
    }

    if (levelNum === 5) {
      projectStage.orderId = 1;
      projectStage.numberOfPlants = 1;
      projectStage.rate = 1;
      projectStage.orderStatus = 1;
      projectStage.farmer = 1;
      projectStage.orderBookingDate = 1;
      projectStage.deliveryDate = 1;
    }

    pipeline.push({ $project: projectStage });

    // Sort results
    const sortStage = {};
    if (levelNum === 1) {
      sortStage.salesPersonName = 1;
    } else if (levelNum === 2) {
      sortStage.districtName = 1;
    } else if (levelNum === 3) {
      sortStage.talukaName = 1;
    } else if (levelNum === 4) {
      sortStage.village = 1;
    } else {
      sortStage.orderBookingDate = -1;
    }
    pipeline.push({ $sort: sortStage });

    const results = await Order.aggregate(pipeline);

    return res.status(200).json({
      success: true,
      data: results
    });
  } catch (error) {
    console.error("Error in getSalesmenBucketing:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while fetching salesmen bucketing data.",
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
  getDealerWalletBalanceForOrder,
  getOrdersToBeDispatched,
  getAllCavitiesFromOrders,
  getOrderBucketing,
  getSalesmenBucketing
};
