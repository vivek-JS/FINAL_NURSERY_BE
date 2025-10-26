import mongoose from "mongoose";
import {
  sendOrderAcceptedNotification,
  sendOrderRejectedNotification,
  sendOrderDispatchedNotification,
  sendOrderStatusNotification,
} from "./pushNotification.js";

/**
 * Send notification when order status changes
 * This is called automatically by the Order model's post-save hook
 * 
 * @param {Object} order - The order document
 * @param {String} oldStatus - Previous status
 * @param {String} newStatus - New status
 */
export async function sendStatusChangeNotification(order, oldStatus, newStatus) {
  try {
    console.log(`📱 Order #${order.orderId} status changed: ${oldStatus} → ${newStatus}`);

    // Find who to notify based on order type
    const User = mongoose.model("User");
    let userToNotify = null;

    if (order.dealer) {
      // Dealer order - notify the dealer
      userToNotify = await User.findById(order.dealer);
      console.log(`📱 Dealer order - notifying dealer: ${userToNotify?.name || "Unknown"}`);
    } else if (order.salesPerson) {
      // Farmer order - notify the sales person
      userToNotify = await User.findById(order.salesPerson);
      console.log(`📱 Farmer order - notifying sales person: ${userToNotify?.name || "Unknown"}`);
    }

    // Check if user has push token
    if (!userToNotify || !userToNotify.expoPushToken) {
      console.log(`⚠️ No push token found for user, skipping notification`);
      console.log(`   User: ${userToNotify?.name || "Unknown"} (${userToNotify?.phoneNumber || "N/A"})`);
      console.log(`   💡 User needs to open the mobile app to register for notifications`);
      return;
    }

    const orderId = order.orderId || order._id;
    const pushToken = userToNotify.expoPushToken;

    // Send appropriate notification based on new status
    switch (newStatus) {
      case "ACCEPTED":
      case "CONFIRMED":
        await sendOrderAcceptedNotification(pushToken, orderId, {
          plantName: order.plantName?.name || "plants",
          quantity: order.numberOfPlants,
        });
        console.log(`✅ Order accepted notification sent for Order #${orderId}`);
        break;

      case "REJECTED":
      case "CANCELLED":
        // Find the reason from status changes
        const latestStatusChange = order.statusChanges?.[order.statusChanges.length - 1];
        const reason = latestStatusChange?.reason || "No reason provided";
        await sendOrderRejectedNotification(pushToken, orderId, reason);
        console.log(`❌ Order rejected notification sent for Order #${orderId}`);
        break;

      case "FARM_READY":
        // Get farmer details for notification
        const Farmer = mongoose.model("Farmer");
        const farmerDetails = order.farmer 
          ? await Farmer.findById(order.farmer)
          : null;
        
        const farmerName = farmerDetails?.name || "Unknown Farmer";
        const farmerVillage = farmerDetails?.village || "Unknown Village";
        
        const farmReadyMessage = `Order #${orderId} is ready for dispatch!\nFarmer: ${farmerName}\nVillage: ${farmerVillage}`;
        await sendOrderStatusNotification(pushToken, orderId, "FARM_READY", farmReadyMessage);
        console.log(`🌾 Farm ready notification sent for Order #${orderId}`);
        console.log(`   Farmer: ${farmerName}, Village: ${farmerVillage}`);
        break;

      case "DISPATCHED":
      case "DISPATCH_PROCESS":
        await sendOrderDispatchedNotification(pushToken, orderId, {});
        console.log(`🚚 Order dispatched notification sent for Order #${orderId}`);
        break;

      case "COMPLETED":
        const completedMessage = `Order #${orderId} has been completed successfully!`;
        await sendOrderStatusNotification(pushToken, orderId, "COMPLETED", completedMessage);
        console.log(`✅ Order completed notification sent for Order #${orderId}`);
        break;

      default:
        // For other status changes, send a generic notification
        const genericMessage = `Order #${orderId} status updated to ${newStatus}`;
        await sendOrderStatusNotification(pushToken, orderId, newStatus, genericMessage);
        console.log(`📋 Status update notification sent for Order #${orderId}: ${newStatus}`);
        break;
    }

    console.log(`✅ Notification successfully sent to ${userToNotify.name} (${userToNotify.phoneNumber})`);
  } catch (error) {
    console.error(`❌ Error in sendStatusChangeNotification:`, error);
    console.error(`   Order ID: ${order.orderId || order._id}`);
    console.error(`   Status Change: ${oldStatus} → ${newStatus}`);
    // Don't throw - we don't want to fail the order update if notification fails
  }
}

/**
 * Manually send a test notification for debugging
 * @param {String} orderId - Order ID
 */
export async function sendTestNotification(orderId) {
  try {
    const Order = mongoose.model("Order");
    const order = await Order.findOne({ orderId: parseInt(orderId) });
    
    if (!order) {
      console.log(`❌ Order #${orderId} not found`);
      return;
    }

    console.log(`🧪 Sending test notification for Order #${orderId}`);
    await sendStatusChangeNotification(order, "TEST", order.orderStatus);
    console.log(`✅ Test notification sent!`);
  } catch (error) {
    console.error(`❌ Error sending test notification:`, error);
  }
}



