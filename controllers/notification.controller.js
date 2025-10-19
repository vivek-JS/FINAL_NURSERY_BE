import User from "../models/user.model.js";
import Order from "../models/order.model.js";
import {
  sendCustomNotification,
  sendOrderAcceptedNotification,
  sendOrderRejectedNotification,
  sendOrderDispatchedNotification,
} from "../utility/pushNotification.js";

/**
 * Save user's push notification token
 */
export const savePushToken = async (req, res) => {
  try {
    const { pushToken } = req.body;
    const userId = req.user._id;

    console.log('💾 Saving push token for user:', userId);
    console.log('📱 Token preview:', pushToken?.substring(0, 30) + '...');

    if (!pushToken) {
      return res.status(400).json({ 
        success: false,
        message: "Push token is required" 
      });
    }

    // Update user with push token
    const updatedUser = await User.findByIdAndUpdate(
      userId, 
      { expoPushToken: pushToken },
      { new: true, runValidators: false }
    );

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    console.log('✅ Push token saved for user:', updatedUser.name);

    res.status(200).json({ 
      success: true,
      message: "Push token saved successfully",
      pushToken,
      user: {
        name: updatedUser.name,
        phone: updatedUser.phoneNumber
      }
    });
  } catch (error) {
    console.error('❌ Error saving push token:', error);
    res.status(500).json({
      success: false,
      message: "Failed to save push token",
      error: error.message
    });
  }
};

/**
 * Send custom notification (for web admin to send manual messages)
 * POST /api/v1/notifications/send-custom
 * Body: { userId, title, message, data }
 */
export const sendCustomNotificationToUser = async (req, res) => {
  try {
    const { userId, title, message, data = {} } = req.body;

    if (!userId || !title || !message) {
      return res.status(400).json({
        success: false,
        message: "userId, title, and message are required"
      });
    }

    // Get user's push token
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    if (!user.expoPushToken) {
      return res.status(400).json({
        success: false,
        message: "User doesn't have a push token. They need to open the mobile app first."
      });
    }

    console.log(`📤 Sending custom notification to ${user.name} (${user.phoneNumber})`);
    console.log(`   Title: ${title}`);
    console.log(`   Message: ${message}`);

    // Send notification
    const result = await sendCustomNotification(user.expoPushToken, title, message, data);

    res.json({
      success: true,
      message: "Notification sent successfully",
      result,
      sentTo: {
        name: user.name,
        phone: user.phoneNumber
      }
    });
  } catch (error) {
    console.error('❌ Error sending custom notification:', error);
    res.status(500).json({
      success: false,
      message: "Failed to send notification",
      error: error.message
    });
  }
};

/**
 * Send notification to multiple users
 * POST /api/v1/notifications/send-bulk
 * Body: { userIds, title, message, data }
 */
export const sendBulkNotification = async (req, res) => {
  try {
    const { userIds, title, message, data = {} } = req.body;

    if (!userIds || !Array.isArray(userIds) || !title || !message) {
      return res.status(400).json({
        success: false,
        message: "userIds (array), title, and message are required"
      });
    }

    // Get users with push tokens
    const users = await User.find({
      _id: { $in: userIds },
      expoPushToken: { $exists: true, $ne: null }
    });

    if (users.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No users found with push tokens"
      });
    }

    const pushTokens = users.map(u => u.expoPushToken);

    console.log(`📤 Sending bulk notification to ${users.length} users`);
    console.log(`   Title: ${title}`);
    console.log(`   Message: ${message}`);

    // Send notification
    const result = await sendCustomNotification(pushTokens, title, message, data);

    res.json({
      success: true,
      message: `Notification sent to ${users.length} users`,
      result,
      sentTo: users.map(u => ({ name: u.name, phone: u.phoneNumber }))
    });
  } catch (error) {
    console.error('❌ Error sending bulk notification:', error);
    res.status(500).json({
      success: false,
      message: "Failed to send notifications",
      error: error.message
    });
  }
};

/**
 * Send notification by phone number (easier for web UI)
 * POST /api/v1/notifications/send-by-phone
 * Body: { phoneNumber, title, message, data }
 */
export const sendNotificationByPhone = async (req, res) => {
  try {
    const { phoneNumber, title, message, data = {} } = req.body;

    if (!phoneNumber || !title || !message) {
      return res.status(400).json({
        success: false,
        message: "phoneNumber, title, and message are required"
      });
    }

    // Get user by phone number
    const user = await User.findOne({ phoneNumber: Number(phoneNumber) });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: `User with phone number ${phoneNumber} not found`
      });
    }

    if (!user.expoPushToken) {
      return res.status(400).json({
        success: false,
        message: `User ${user.name} doesn't have a push token. They need to open the mobile app first.`
      });
    }

    console.log(`📤 Sending notification to ${user.name} (${user.phoneNumber})`);
    console.log(`   Title: ${title}`);
    console.log(`   Message: ${message}`);

    // Send notification
    const result = await sendCustomNotification(user.expoPushToken, title, message, data);

    res.json({
      success: true,
      message: "Notification sent successfully",
      result,
      sentTo: {
        name: user.name,
        phone: user.phoneNumber
      }
    });
  } catch (error) {
    console.error('❌ Error sending notification:', error);
    res.status(500).json({
      success: false,
      message: "Failed to send notification",
      error: error.message
    });
  }
};

