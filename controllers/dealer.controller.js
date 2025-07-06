// import DealerOrder from '../models/DealerOrder';
// import DealerBooking from '../models/DealerBooking';
import mongoose from "mongoose";
import DealerOrder from "../models/dealerOrder.model.js";
import DealerBooking from "../models/dealerBooking.model.js";
import { createOne, updateSlot } from "./factory.controller.js";
import Order from "../models/order.model.js";

// Helper function to calculate plants per slot
const calculatePlantsPerSlot = (totalPlants, numberOfSlots) => {
  const basePlants = Math.floor(totalPlants / numberOfSlots);
  const remainder = totalPlants % numberOfSlots;

  return Array(numberOfSlots)
    .fill(basePlants)
    .map((plants, index) => (index < remainder ? plants + 1 : plants));
};



// Add this for order cancellation or updates
export const cancelDealerOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { orderId } = req.params;

    // Find the order
    const order = await DealerOrder.findById(orderId);
    if (!order) {
      throw new Error("Order not found");
    }

    // Calculate plants per slot for refund
    const plantsPerSlot = calculatePlantsPerSlot(
      order.numberOfPlants,
      order.bookingSlots.length
    );

    // Update all booking slots to add back the plants
    for (let i = 0; i < order.bookingSlots.length; i++) {
      try {
        await updateSlot(order.bookingSlots[i], plantsPerSlot[i], "add");
      } catch (error) {
        throw new Error(
          `Failed to update slot ${order.bookingSlots[i]}: ${error.message}`
        );
      }
    }

    // Update order status
    order.orderStatus = "CANCELLED";
    await order.save({ session });

    // Update dealer booking summary
    const dealerBooking = await DealerBooking.findOne({ dealer: order.dealer });
    if (dealerBooking) {
      dealerBooking.summary.totalBooked -= order.numberOfPlants;
      // Update other relevant summary fields
      await dealerBooking.save({ session });
    }

    await session.commitTransaction();

    res.status(200).json({
      success: true,
      message: "Order cancelled successfully",
    });
  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({
      success: false,
      message: "Error cancelling order",
      error: error.message,
    });
  } finally {
    session.endSession();
  }
};
// Get dealer orders by booking
export const getDealerOrdersByBooking = async (req, res) => {
  try {
    const dealerId = req.user._id;

    const dealerBooking = await DealerBooking.findOne({
      dealer: dealerId,
    }).populate({
      path: "orders",
      populate: [
        { path: "farmer" },
        { path: "plantName" },
        { path: "plantSubtype" },
        { path: "bookingSlots" },
      ],
    });

    if (!dealerBooking) {
      return res.status(404).json({
        success: false,
        message: "No dealer booking found",
      });
    }

    res.status(200).json({
      success: true,
      data: dealerBooking,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching dealer orders",
      error: error.message,
    });
  }
};

// Update dealer order payment
export const updateDealerOrderPayment = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { orderId } = req.params;
    const { payment } = req.body;
    const dealerId = req.user._id;

    const order = await DealerOrder.findOne({
      _id: orderId,
      dealer: dealerId,
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    // Add new payment
    order.payment.push(payment);

    // Calculate total payments
    const totalPayments = order.payment.reduce(
      (sum, p) => sum + (p.paymentStatus === "COLLECTED" ? p.paidAmount : 0),
      0
    );

    // Update order payment status
    const orderTotal = order.numberOfPlants * order.rate;
    if (totalPayments >= orderTotal) {
      order.orderPaymentStatus = "COMPLETED";
      order.paymentCompleted = true;
    }

    await order.save({ session });

    // Update dealer booking summary
    const dealerBooking = await DealerBooking.findOne({ dealer: dealerId });
    if (dealerBooking) {
      dealerBooking.summary.totalOrderPayments += payment.paidAmount;
      dealerBooking.summary.paymentRemaining -= payment.paidAmount;
      await dealerBooking.save({ session });
    }

    await session.commitTransaction();

    res.status(200).json({
      success: true,
      message: "Payment updated successfully",
      data: {
        order,
        booking: dealerBooking,
      },
    });
  } catch (error) {
    await session.abortTransaction();

    res.status(500).json({
      success: false,
      message: "Error updating payment",
      error: error.message,
    });
  } finally {
    session.endSession();
  }
};

export const createDealerOrder = () =>{
  
}
