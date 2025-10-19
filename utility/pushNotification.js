import axios from 'axios';

/**
 * Send push notification using Expo Push Notification Service
 * @param {String|Array} expoPushTokens - Single token or array of tokens
 * @param {String} title - Notification title
 * @param {String} body - Notification body
 * @param {Object} data - Additional data to send with notification
 * @param {String} channelId - Android notification channel ID
 * @returns {Promise} - Result of push notification send
 */
export async function sendPushNotification(
  expoPushTokens,
  title,
  body,
  data = {},
  channelId = 'default'
) {
  try {
    // Ensure tokens is an array
    const tokens = Array.isArray(expoPushTokens) ? expoPushTokens : [expoPushTokens];
    
    // Filter out invalid tokens
    const validTokens = tokens.filter(
      token => token && token.startsWith('ExponentPushToken[')
    );

    if (validTokens.length === 0) {
      console.log('No valid Expo push tokens provided');
      return { success: false, message: 'No valid tokens' };
    }

    // Prepare messages
    const messages = validTokens.map(token => ({
      to: token,
      sound: 'default',
      title,
      body,
      data,
      priority: 'high',
      channelId,
    }));

    // Send to Expo Push Notification Service
    const response = await axios.post(
      'https://exp.host/--/api/v2/push/send',
      messages,
      {
        headers: {
          'Accept': 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('Push notification sent successfully:', response.data);
    return { success: true, data: response.data };
  } catch (error) {
    console.error('Error sending push notification:', error.message);
    if (error.response) {
      console.error('Response error:', error.response.data);
    }
    return { success: false, error: error.message };
  }
}

/**
 * Send payment accepted notification
 * @param {String|Array} expoPushTokens - User's push token(s)
 * @param {String} orderId - Order ID
 * @param {Number} amount - Payment amount
 * @returns {Promise}
 */
export async function sendPaymentAcceptedNotification(expoPushTokens, orderId, amount) {
  return sendPushNotification(
    expoPushTokens,
    '✅ Payment Accepted',
    `Your payment of ₹${amount} for Order #${orderId} has been accepted!`,
    {
      type: 'payment',
      status: 'accepted',
      orderId,
      amount,
    },
    'payment'
  );
}

/**
 * Send payment rejected notification
 * @param {String|Array} expoPushTokens - User's push token(s)
 * @param {String} orderId - Order ID
 * @param {Number} amount - Payment amount
 * @param {String} reason - Rejection reason
 * @returns {Promise}
 */
export async function sendPaymentRejectedNotification(
  expoPushTokens,
  orderId,
  amount,
  reason = ''
) {
  const body = reason
    ? `Your payment of ₹${amount} for Order #${orderId} was rejected. Reason: ${reason}`
    : `Your payment of ₹${amount} for Order #${orderId} was rejected. Please contact support.`;

  return sendPushNotification(
    expoPushTokens,
    '❌ Payment Rejected',
    body,
    {
      type: 'payment',
      status: 'rejected',
      orderId,
      amount,
      reason,
    },
    'payment'
  );
}

/**
 * Send payment pending notification
 * @param {String|Array} expoPushTokens - User's push token(s)
 * @param {String} orderId - Order ID
 * @param {Number} amount - Payment amount
 * @returns {Promise}
 */
export async function sendPaymentPendingNotification(expoPushTokens, orderId, amount) {
  return sendPushNotification(
    expoPushTokens,
    '⏳ Payment Pending',
    `Your payment of ₹${amount} for Order #${orderId} is being processed.`,
    {
      type: 'payment',
      status: 'pending',
      orderId,
      amount,
    },
    'payment'
  );
}

/**
 * Send payment collected notification
 * @param {String|Array} expoPushTokens - User's push token(s)
 * @param {String} orderId - Order ID
 * @param {Number} amount - Payment amount
 * @returns {Promise}
 */
export async function sendPaymentCollectedNotification(expoPushTokens, orderId, amount) {
  return sendPushNotification(
    expoPushTokens,
    '💰 Payment Collected',
    `Payment of ₹${amount} for Order #${orderId} has been collected successfully.`,
    {
      type: 'payment',
      status: 'collected',
      orderId,
      amount,
    },
    'payment'
  );
}

/**
 * Send order status update notification
 * @param {String|Array} expoPushTokens - User's push token(s)
 * @param {String} orderId - Order ID
 * @param {String} status - Order status
 * @param {String} message - Custom message
 * @returns {Promise}
 */
export async function sendOrderStatusNotification(
  expoPushTokens,
  orderId,
  status,
  message
) {
  return sendPushNotification(
    expoPushTokens,
    `📦 Order #${orderId} Update`,
    message,
    {
      type: 'order',
      orderId,
      status,
    },
    'default'
  );
}

/**
 * Send order accepted notification
 * @param {String|Array} expoPushTokens - User's push token(s)
 * @param {String} orderId - Order ID
 * @param {Object} orderDetails - Order details
 * @returns {Promise}
 */
export async function sendOrderAcceptedNotification(expoPushTokens, orderId, orderDetails = {}) {
  const { plantName = 'plants', quantity = 0 } = orderDetails;
  
  return sendPushNotification(
    expoPushTokens,
    '✅ Order Accepted',
    `Your order #${orderId} for ${quantity} ${plantName} has been accepted and is being processed!`,
    {
      type: 'order',
      orderId,
      status: 'ACCEPTED',
      ...orderDetails,
    },
    'default'
  );
}

/**
 * Send order rejected notification
 * @param {String|Array} expoPushTokens - User's push token(s)
 * @param {String} orderId - Order ID
 * @param {String} reason - Rejection reason
 * @returns {Promise}
 */
export async function sendOrderRejectedNotification(expoPushTokens, orderId, reason = '') {
  const body = reason
    ? `Your order #${orderId} was rejected. Reason: ${reason}`
    : `Your order #${orderId} was rejected. Please contact support for details.`;

  return sendPushNotification(
    expoPushTokens,
    '❌ Order Rejected',
    body,
    {
      type: 'order',
      orderId,
      status: 'REJECTED',
      reason,
    },
    'default'
  );
}

/**
 * Send order dispatched notification
 * @param {String|Array} expoPushTokens - User's push token(s)
 * @param {String} orderId - Order ID
 * @param {Object} dispatchDetails - Dispatch details
 * @returns {Promise}
 */
export async function sendOrderDispatchedNotification(expoPushTokens, orderId, dispatchDetails = {}) {
  const { dispatchDate = 'soon' } = dispatchDetails;
  
  return sendPushNotification(
    expoPushTokens,
    '🚚 Order Dispatched',
    `Your order #${orderId} has been dispatched! Expected delivery: ${dispatchDate}`,
    {
      type: 'order',
      orderId,
      status: 'DISPATCHED',
      ...dispatchDetails,
    },
    'default'
  );
}

/**
 * Send custom notification (for manual messages from web)
 * @param {String|Array} expoPushTokens - User's push token(s)
 * @param {String} title - Notification title
 * @param {String} message - Notification message
 * @param {Object} data - Additional data
 * @returns {Promise}
 */
export async function sendCustomNotification(expoPushTokens, title, message, data = {}) {
  return sendPushNotification(
    expoPushTokens,
    title,
    message,
    {
      type: 'custom',
      ...data,
    },
    'default'
  );
}

// Named exports are already done above with 'export' keyword
// No need for module.exports in ES modules

