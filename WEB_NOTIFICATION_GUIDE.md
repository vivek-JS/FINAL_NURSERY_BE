# Web Notification Integration Guide

## 🔔 Push Notification System for Web Admin

This guide shows how to send push notifications from the web application to mobile app users.

## 📱 What's Available

### 1. **Automatic Notifications** ✅
Already implemented! Notifications are sent automatically when:
- ✅ Payment status changes (COLLECTED, REJECTED, PENDING)
- ✅ Order status changes (ACCEPTED, REJECTED, DISPATCHED, etc.)

### 2. **Manual Notifications** 🎯
Send custom messages to users from the web interface.

---

## 🚀 API Endpoints

### Base URL
```
http://localhost:8000/api/v1/notifications
```

All endpoints require authentication. Include JWT token in headers:
```
Authorization: Bearer YOUR_JWT_TOKEN
```

---

## 📤 Send Notification by Phone Number (Easiest!)

**Best for web UI** - No need to know user ID!

### Endpoint
```
POST /api/v1/notifications/send-by-phone
```

### Request Body
```json
{
  "phoneNumber": "9309109344",
  "title": "Important Update",
  "message": "Your order will be delivered tomorrow!",
  "data": {
    "orderId": "123",
    "type": "custom"
  }
}
```

### Response
```json
{
  "success": true,
  "message": "Notification sent successfully",
  "result": {
    "success": true,
    "data": { ... }
  },
  "sentTo": {
    "name": "Ram Agri Sales",
    "phone": 9309109344
  }
}
```

### JavaScript Example
```javascript
async function sendNotification() {
  const response = await fetch('http://localhost:8000/api/v1/notifications/send-by-phone', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${yourJWTToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      phoneNumber: '9309109344',
      title: '📦 Order Update',
      message: 'Your order #123 is ready for pickup!',
      data: {
        orderId: '123',
        action: 'view_order'
      }
    })
  });

  const result = await response.json();
  console.log(result);
}
```

---

## 📤 Send to Single User by ID

### Endpoint
```
POST /api/v1/notifications/send-custom
```

### Request Body
```json
{
  "userId": "68xxxxxxxxxxxxx",
  "title": "Payment Reminder",
  "message": "Please complete payment for Order #456",
  "data": {
    "orderId": "456"
  }
}
```

---

## 📤 Send to Multiple Users (Bulk)

### Endpoint
```
POST /api/v1/notifications/send-bulk
```

### Request Body
```json
{
  "userIds": ["68xxx1", "68xxx2", "68xxx3"],
  "title": "System Announcement",
  "message": "New plants available in stock!",
  "data": {
    "type": "announcement"
  }
}
```

### Response
```json
{
  "success": true,
  "message": "Notification sent to 3 users",
  "sentTo": [
    { "name": "User 1", "phone": 1234567890 },
    { "name": "User 2", "phone": 9876543210 }
  ]
}
```

---

## 🎨 React/Next.js Component Example

```javascript
import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth'; // Your auth hook

export default function SendNotificationForm({ phoneNumber, orderId }) {
  const { token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');

  const handleSendNotification = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      const response = await fetch('/api/v1/notifications/send-by-phone', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          phoneNumber,
          title,
          message,
          data: { orderId }
        })
      });

      const result = await response.json();
      
      if (result.success) {
        alert('✅ Notification sent successfully!');
        setTitle('');
        setMessage('');
      } else {
        alert('❌ Failed to send notification');
      }
    } catch (error) {
      alert('Error: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSendNotification} className="space-y-4">
      <div>
        <label>Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full border p-2 rounded"
          placeholder="Notification title"
          required
        />
      </div>

      <div>
        <label>Message</label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="w-full border p-2 rounded"
          placeholder="Notification message"
          rows={4}
          required
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
      >
        {loading ? 'Sending...' : 'Send Notification 📤'}
      </button>
    </form>
  );
}
```

---

## 📋 Use Cases & Examples

### 1. Order Reminder
```javascript
{
  "phoneNumber": "9309109344",
  "title": "⏰ Reminder",
  "message": "Please collect your order #123 today!"
}
```

### 2. Payment Request
```javascript
{
  "phoneNumber": "9309109344",
  "title": "💰 Payment Due",
  "message": "Payment of ₹5000 is pending for Order #456"
}
```

### 3. Stock Alert
```javascript
{
  "phoneNumber": "9309109344",
  "title": "🌱 New Stock",
  "message": "Banana G9 plants now available! Order now."
}
```

### 4. Custom Announcement
```javascript
{
  "phoneNumber": "9309109344",
  "title": "📢 Announcement",
  "message": "Our office will be closed tomorrow for maintenance."
}
```

---

## ✅ Automatic Notifications (Already Working!)

These happen automatically - **no web integration needed:**

### Payment Status Changes
```
PENDING → User gets: "⏳ Payment Pending..."
COLLECTED → User gets: "✅ Payment Accepted..."
REJECTED → User gets: "❌ Payment Rejected..."
```

### Order Status Changes
```
ACCEPTED → User gets: "✅ Order Accepted and is being processed!"
REJECTED → User gets: "❌ Order Rejected. Reason: ..."
DISPATCHED → User gets: "🚚 Order Dispatched! Expected delivery: ..."
```

---

## 🚨 Error Handling

### User Not Found
```json
{
  "success": false,
  "message": "User with phone number 1234567890 not found"
}
```

### No Push Token
```json
{
  "success": false,
  "message": "User Ram Agri Sales doesn't have a push token. They need to open the mobile app first."
}
```

**Solution:** User must open and login to the mobile app to register for notifications.

---

## 💡 Best Practices

### 1. Keep Messages Short
✅ Good: "Your order #123 is ready!"
❌ Bad: "Hello, we wanted to inform you that your order number 123 with 500 Banana G9 plants has been processed and is now ready for collection at our facility..."

### 2. Use Emojis for Impact
- ✅ Success/Confirmation
- ❌ Error/Rejection
- ⏰ Reminder
- 💰 Payment
- 📦 Order
- 🚚 Dispatch
- 🌱 Plants/Stock

### 3. Include Action Data
```javascript
data: {
  orderId: "123",
  action: "view_order", // App can navigate to order
  type: "payment"
}
```

### 4. Check Before Sending
```javascript
// First, verify user has a push token
const user = await fetch(`/api/v1/user/aboutMe?phone=${phoneNumber}`);
if (!user.expoPushToken) {
  alert('User needs to open mobile app first');
  return;
}
```

---

## 🧪 Testing

### Test Endpoint
```bash
curl -X POST http://localhost:8000/api/v1/notifications/send-by-phone \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "9309109344",
    "title": "Test Notification",
    "message": "This is a test message!"
  }'
```

### Test in Browser Console
```javascript
fetch('http://localhost:8000/api/v1/notifications/send-by-phone', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + localStorage.getItem('token'),
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    phoneNumber: '9309109344',
    title: 'Test',
    message: 'Hello from web!'
  })
})
.then(r => r.json())
.then(console.log)
```

---

## 📊 UI Integration Examples

### 1. Button in Order Details Page
```jsx
<button onClick={() => sendNotification({
  phoneNumber: order.farmer.phoneNumber,
  title: 'Order Ready',
  message: `Your order #${order.orderId} is ready for pickup!`
})}>
  Send Notification 📤
</button>
```

### 2. Bulk Notification Dialog
```jsx
<Dialog>
  <DialogTitle>Send Announcement</DialogTitle>
  <DialogContent>
    <TextField
      label="Title"
      value={title}
      onChange={(e) => setTitle(e.target.value)}
    />
    <TextField
      label="Message"
      multiline
      rows={4}
      value={message}
      onChange={(e) => setMessage(e.target.value)}
    />
    <Button onClick={sendToAllDealers}>
      Send to All Dealers
    </Button>
  </DialogContent>
</Dialog>
```

### 3. Quick Actions Menu
```jsx
<Menu>
  <MenuItem onClick={() => sendPaymentReminder()}>
    💰 Send Payment Reminder
  </MenuItem>
  <MenuItem onClick={() => sendPickupReminder()}>
    📦 Send Pickup Reminder
  </MenuItem>
  <MenuItem onClick={() => sendCustomMessage()}>
    ✉️ Send Custom Message
  </MenuItem>
</Menu>
```

---

## 🔐 Security & Permissions

### Who Can Send Notifications?
- ✅ Super Admins
- ✅ Accountants (for payment notifications)
- ✅ Office Admins
- ❌ Regular sales users

### Backend validates:
- ✅ Valid JWT token
- ✅ User exists
- ✅ Phone number format
- ✅ Push token exists

---

## 📖 Quick Reference

| What | Endpoint | Required Fields |
|------|----------|----------------|
| Send by Phone | `/send-by-phone` | `phoneNumber`, `title`, `message` |
| Send by User ID | `/send-custom` | `userId`, `title`, `message` |
| Send to Multiple | `/send-bulk` | `userIds[]`, `title`, `message` |

---

## 🎉 You're All Set!

The notification system is **fully functional**. You can now:
1. ✅ Send manual notifications from web
2. ✅ Automatic notifications on payment/order changes
3. ✅ Test with the provided endpoints
4. ✅ Integrate into your web UI

**Need help?** Check the backend logs for notification delivery status!

---

**Last Updated:** October 2025
**Version:** 1.0.0

