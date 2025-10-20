# 📱 WhatsApp Order Automation - Automatic Messages on Order Acceptance

## ✅ **Feature Implemented**

Automatic WhatsApp messages are now sent to farmers when:
1. **Order is Accepted** - Farmer receives order confirmation via WhatsApp
2. **Order is Farm Ready** - Farmer receives ready for pickup notification

---

## 🎯 **How It Works**

### **Automatic Triggers:**

#### **1. Order Accepted/Confirmed**
```
When: Order status changes to ACCEPTED or CONFIRMED
To: Farmer's mobile number
Template: order_accepted
Parameters:
  - Farmer Name
  - Order Number
  - Plant Name
  - Quantity
  - Delivery Date
  - Total Amount
```

#### **2. Farm Ready**
```
When: Order status changes to FARM_READY
To: Farmer's mobile number
Template: order_ready
Parameters:
  - Farmer Name
  - Order Number
  - Plant Name
  - Quantity
  - Delivery Date
```

---

## 📁 **Files Changed**

### **1. New File: `FINAL_NURSERY_BE/utility/watiMessaging.js`**
- **Purpose**: WhatsApp messaging utility functions
- **Functions**:
  - `sendWatiTemplateMessage()` - Core WATI API caller
  - `sendOrderAcceptedWhatsApp()` - Send order accepted message
  - `sendOrderReadyWhatsApp()` - Send farm ready message
  - `sendPaymentReminderWhatsApp()` - Send payment reminder
  - `sendCustomWhatsApp()` - Send custom messages

### **2. Updated: `FINAL_NURSERY_BE/controllers/factory.controller.js`**
- **Lines Added**: 950-1014
- **Integration**: Added WhatsApp messaging in order status change flow
- **Async**: Messages sent asynchronously (don't block order updates)
- **Error Handling**: Failures logged but don't affect order processing

---

## 🔧 **Configuration**

### **Environment Variables (.env)**

Add these to your `FINAL_NURSERY_BE/.env` file:

```bash
# WATI WhatsApp API Configuration
WATI_URL=https://live-mt-server.wati.io/385403
WATI_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIwNjY4YWY5Zi1jN2I1LTQ2N2QtOWU0Yi01ZjRjOTJhNThlZjMiLCJ1bmlxdWVfbmFtZSI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwibmFtZWlkIjoidml2ZWtjLmFwa0BnbWFpbC5jb20iLCJlbWFpbCI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwiYXV0aF90aW1lIjoiMDkvMjEvMjAyNSAwNDo1ODozMiIsInRlbmFudF9pZCI6IjM4NTQwMyIsImRiX25hbWUiOiJtdC1wcm9kLVRlbmFudHMiLCJodHRwOi8vc2NoZW1hcy5taWNyb3NvZnQuY29tL3dzLzIwMDgvMDYvaWRlbnRpdHkvY2xhaW1zL3JvbGUiOiJBRE1JTklTVFJBVE9SIiwiZXhwIjoyNTM0MDIzMDA4MDAsImlzcyI6IkNsYXJlX0FJIiwiYXVkIjoiQ2xhcmVfQUkifQ.zAP3ZxQXUO1NWJGLe0e39qVeiXLK_d8U2y0bonMjomw
SEND_TEMPLATE_MESSAGE_URL=https://live-mt-server.wati.io/385403/api/v1/sendTemplateMessage
```

**Note**: Update the `WATI_TOKEN` with your actual WATI API token.

---

## 📝 **WATI Template Setup**

You need to create these templates in your WATI dashboard:

### **1. Order Accepted Template**

**Template Name**: `order_accepted`

**Template Content** (Example):
```
नमस्ते {{name}},

आपका ऑर्डर #{{orderNumber}} स्वीकार कर लिया गया है! ✅

📦 पौधा: {{plant}}
🔢 संख्या: {{quantity}}
📅 डिलीवरी: {{delivery}}
💰 राशि: {{amount}}

आपका ऑर्डर तैयार किया जा रहा है।

धन्यवाद!
Ram Nursery
```

**Parameters**:
1. `name` - Farmer name
2. `orderNumber` - Order ID
3. `plant` - Plant name
4. `quantity` - Number of plants
5. `delivery` - Delivery date
6. `amount` - Total amount

---

### **2. Farm Ready Template**

**Template Name**: `order_ready`

**Template Content** (Example):
```
नमस्ते {{name}},

आपका ऑर्डर #{{orderNumber}} तैयार है! 🌱

📦 पौधा: {{plant}}
🔢 संख्या: {{quantity}}
📅 डिलीवरी: {{delivery}}

कृपया अपने पौधे लेने आएं।

धन्यवाद!
Ram Nursery
```

**Parameters**:
1. `name` - Farmer name
2. `orderNumber` - Order ID
3. `plant` - Plant name
4. `quantity` - Number of plants
5. `delivery` - Delivery date

---

### **3. Payment Reminder Template (Optional)**

**Template Name**: `payment_reminder`

**Template Content** (Example):
```
नमस्ते {{name}},

ऑर्डर #{{orderNumber}} के लिए भुगतान याद दिलाने के लिए।

💰 बकाया राशि: {{amount}}
📅 नियत तारीख: {{dueDate}}

कृपया जल्द से जल्द भुगतान करें।

धन्यवाद!
Ram Nursery
```

**Parameters**:
1. `name` - Farmer name
2. `orderNumber` - Order ID
3. `amount` - Remaining amount
4. `dueDate` - Due date

---

## 🚀 **Testing**

### **Test Order Acceptance Message:**

1. Create a new order with a farmer's mobile number
2. Accept the order (change status to ACCEPTED)
3. Check backend logs:
   ```
   📱 Sending WhatsApp order accepted message to farmer: John Doe (9876543210)
   📤 Sending WATI message to 9876543210 using template: order_accepted
   ✅ WATI message sent successfully to 9876543210
   ✅ WhatsApp message sent successfully for Order #123
   ```
4. Farmer should receive WhatsApp message

### **Test Farm Ready Message:**

1. Change order status to FARM_READY
2. Check backend logs:
   ```
   📱 Sending WhatsApp farm ready message to farmer: John Doe (9876543210)
   ✅ WhatsApp farm ready message sent successfully for Order #123
   ```
3. Farmer should receive WhatsApp message

---

## 🔍 **Debugging**

### **Enable Debug Logs:**

The system automatically logs all WhatsApp operations:

```
📱 Sending WhatsApp order accepted message to farmer: [Name] ([Mobile])
📤 Sending WATI message to [Mobile] using template: [Template]
✅ WATI message sent successfully to [Mobile]
✅ WhatsApp message sent successfully for Order #[ID]
```

### **Error Handling:**

If WhatsApp fails, the order update still succeeds:

```
❌ WATI API error: [Error Details]
⚠️ WhatsApp message failed for Order #[ID]: [Reason]
```

### **Common Issues:**

1. **"WATI not configured"**
   - Solution: Set `WATI_TOKEN` in `.env` file

2. **"No farmer mobile number found"**
   - Solution: Ensure farmer record has `mobileNumber` field

3. **"Template not found"**
   - Solution: Create template in WATI dashboard with exact name

4. **"Message failed"**
   - Check WATI dashboard for template approval status
   - Verify mobile number format (10 digits)
   - Check WATI API credits

---

## 📊 **Message Flow**

```
┌─────────────────────────────────────────┐
│  User Accepts Order (Web/Mobile)       │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  Order Status Changed to ACCEPTED       │
└────────────────┬────────────────────────┘
                 │
                 ├──────────────┐
                 │              │
                 ▼              ▼
┌──────────────────────┐  ┌──────────────────────┐
│  Push Notification   │  │  WhatsApp Message    │
│  to Sales/Dealer     │  │  to Farmer           │
└──────────────────────┘  └──────────────────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │  Farmer's Phone  │
                         │  (WhatsApp App)  │
                         └──────────────────┘
```

---

## 💡 **Features**

✅ **Async Processing**: Messages sent asynchronously, don't block order updates
✅ **Error Resilient**: Order updates succeed even if WhatsApp fails
✅ **Auto-Format**: Phone numbers automatically formatted (91 prefix)
✅ **Template Support**: Uses WATI approved templates
✅ **Multi-language**: Supports English, Marathi, Hindi
✅ **Comprehensive Logging**: All operations logged for debugging
✅ **Farmer Details**: Fetches farmer name, mobile, and order details
✅ **Date Formatting**: Dates formatted in DD/MM/YYYY format
✅ **Amount Formatting**: Currency formatted with ₹ symbol

---

## 🎯 **Use Cases**

### **1. Order Confirmation**
- Farmer places order via sales person
- Sales person accepts order in web/mobile app
- **Farmer receives instant WhatsApp confirmation** ✅

### **2. Farm Ready Notification**
- Nursery marks order as Farm Ready
- **Farmer receives WhatsApp notification to collect plants** ✅

### **3. Payment Reminder** (Optional)
- Admin can manually trigger payment reminders
- Farmers receive WhatsApp payment reminders

---

## 🔐 **Security**

- WATI token stored in environment variables
- API calls use HTTPS
- Phone numbers sanitized before sending
- No sensitive data logged
- Error messages don't expose credentials

---

## 📈 **Benefits**

1. **Instant Communication** - Farmers get instant order updates
2. **Reduced Phone Calls** - Less manual calling to farmers
3. **Professional** - Automated, consistent messages
4. **Multi-language** - Support for regional languages
5. **Reliable** - WATI ensures message delivery
6. **Scalable** - Handles hundreds of orders automatically
7. **Trackable** - All messages logged in backend
8. **Cost-Effective** - WATI offers affordable WhatsApp API

---

## 🔄 **Future Enhancements**

- [ ] Add WhatsApp for payment confirmations
- [ ] Add WhatsApp for dispatch updates
- [ ] Add WhatsApp for delivery confirmations
- [ ] Add image attachments (plant photos)
- [ ] Add location sharing for pickup
- [ ] Add interactive buttons (Yes/No responses)
- [ ] Add order status tracking via WhatsApp bot

---

## ✅ **Status**

**Implementation Status**: ✅ **COMPLETE**

- WhatsApp messaging utility created
- Integration with order status changes complete
- Templates documented
- Error handling implemented
- Logging added
- Ready for production use

**Last Updated**: October 20, 2025

---

*For support or questions, contact the development team.*

