// import DealerOrder from '../models/DealerOrder';
// import DealerBooking from '../models/DealerBooking';
import mongoose from 'mongoose';
import DealerOrder from '../models/dealerOrder.model.js';
import DealerBooking from '../models/dealerBooking.model.js';
import { updateSlot } from './factory.controller.js';


// Helper function to calculate plants per slot
const calculatePlantsPerSlot = (totalPlants, numberOfSlots) => {
  const basePlants = Math.floor(totalPlants / numberOfSlots);
  const remainder = totalPlants % numberOfSlots;
  
  return Array(numberOfSlots).fill(basePlants).map((plants, index) => 
    index < remainder ? plants + 1 : plants
  );
};

export const createDealerOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      dealer,
      farmer,
      numberOfPlants,
      plantName,
      plantSubtype,
      bookingSlots,
      rate,
      payment,
      notes
    } = req.body;

    // Calculate plants per slot
    const plantsPerSlot = calculatePlantsPerSlot(numberOfPlants, bookingSlots.length);

    // Update all booking slots
    for (let i = 0; i < bookingSlots.length; i++) {
      try {
        await updateSlot(bookingSlots[i], plantsPerSlot[i], "subtract");
      } catch (error) {
        throw new Error(`Failed to update slot ${bookingSlots[i]}: ${error.message}`);
      }
    }

    // Generate orderId
    const lastOrder = await DealerOrder.findOne({}, { orderId: 1 })
      .sort({ orderId: -1 })
      .limit(1);
    
    const nextOrderId = lastOrder ? lastOrder.orderId + 1 : 1;

    // Create the dealer order
    const newDealerOrder = new DealerOrder({
      orderId: nextOrderId,
      farmer,
      dealer,
      numberOfPlants,
      plantName,
      plantSubtype,
      bookingSlots,
      rate,
      notes,
      payment: payment ? [payment] : []
    });

    // Calculate total payment
    let totalPayment = 0;
    if (payment && payment.paidAmount) {
      totalPayment = payment.paidAmount;
      
      if (totalPayment >= numberOfPlants * rate) {
        newDealerOrder.orderPaymentStatus = 'COMPLETED';
        newDealerOrder.paymentCompleted = true;
      }
    }

    // Save the dealer order
    const savedOrder = await newDealerOrder.save({ session });

    // Find or create dealer booking
    let dealerBooking = await DealerBooking.findOne({ dealer });
    
    if (!dealerBooking) {
      dealerBooking = new DealerBooking({
        dealer,
        orders: [],
        farmerOrders: [],
        summary: {
          totalAvailable: 0,
          totalBooked: 0,
          totalBalance: 0,
          paymentRemaining: 0,
          totalOrderPayments: 0
        }
      });
    }

    // Update dealer booking
    dealerBooking.orders.push(savedOrder._id);
    
    // Update summary
    const orderTotal = numberOfPlants * rate;
    dealerBooking.summary.totalBooked += numberOfPlants;
    dealerBooking.summary.totalBalance += orderTotal;
    dealerBooking.summary.totalOrderPayments += totalPayment;
    dealerBooking.summary.paymentRemaining += (orderTotal - totalPayment);

    await dealerBooking.save({ session });

    // Commit transaction
    await session.commitTransaction();

    res.status(201).json({
      success: true,
      message: 'Dealer order created successfully',
      data: {
        order: savedOrder,
        booking: dealerBooking
      }
    });

  } catch (error) {
    // Rollback transaction on error
    await session.abortTransaction();
    
    res.status(500).json({
      success: false,
      message: 'Error creating dealer order',
      error: error.message
    });
  } finally {
    session.endSession();
  }
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
      throw new Error('Order not found');
    }

    // Calculate plants per slot for refund
    const plantsPerSlot = calculatePlantsPerSlot(order.numberOfPlants, order.bookingSlots.length);

    // Update all booking slots to add back the plants
    for (let i = 0; i < order.bookingSlots.length; i++) {
      try {
        await updateSlot(order.bookingSlots[i], plantsPerSlot[i], "add");
      } catch (error) {
        throw new Error(`Failed to update slot ${order.bookingSlots[i]}: ${error.message}`);
      }
    }

    // Update order status
    order.orderStatus = 'CANCELLED';
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
      message: 'Order cancelled successfully'
    });

  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({
      success: false,
      message: 'Error cancelling order',
      error: error.message
    });
  } finally {
    session.endSession();
  }
};
// Get dealer orders by booking
export const getDealerOrdersByBooking = async (req, res) => {
  try {
    const dealerId = req.user._id;
    
    const dealerBooking = await DealerBooking.findOne({ dealer: dealerId })
      .populate({
        path: 'orders',
        populate: [
          { path: 'farmer' },
          { path: 'plantName' },
          { path: 'plantSubtype' },
          { path: 'bookingSlots' }
        ]
      });

    if (!dealerBooking) {
      return res.status(404).json({
        success: false,
        message: 'No dealer booking found'
      });
    }

    res.status(200).json({
      success: true,
      data: dealerBooking
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching dealer orders',
      error: error.message
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
      dealer: dealerId
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Add new payment
    order.payment.push(payment);
    
    // Calculate total payments
    const totalPayments = order.payment.reduce((sum, p) => 
      sum + (p.paymentStatus === 'COLLECTED' ? p.paidAmount : 0), 0);
    
    // Update order payment status
    const orderTotal = order.numberOfPlants * order.rate;
    if (totalPayments >= orderTotal) {
      order.orderPaymentStatus = 'COMPLETED';
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
      message: 'Payment updated successfully',
      data: {
        order,
        booking: dealerBooking
      }
    });

  } catch (error) {
    await session.abortTransaction();
    
    res.status(500).json({
      success: false,
      message: 'Error updating payment',
      error: error.message
    });
  } finally {
    session.endSession();
  }
};