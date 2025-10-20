# WhatsApp Integration - Working Code from January 2025

## 📱 **Complete WhatsApp Integration System**

This document contains the fully functional WhatsApp integration code that was working in January 2025 using **WATI API**.

---

## 🏗️ **System Architecture**

### **Frontend (React Web App)**
- **WhatsApp Management Dashboard** - Complete template management system
- **Campaign Management** - Send messages to multiple farmers
- **Single Send** - Send messages to individual numbers
- **Template Management** - Create, edit, and manage WhatsApp templates

### **Backend (Node.js API)**
- **Message Controller** - Handle WhatsApp API calls
- **Template Fetching** - Get approved templates from WATI
- **Broadcast Management** - Manage contact lists and groups

---

## 📁 **File Structure**

```
nursery-mgmt/src/
├── pages/private/whatsapp/
│   ├── WhatsAppManagement.js      # Main dashboard
│   ├── FarmerCampaignModal.js     # Bulk messaging
│   └── SingleSendModal.js         # Single number messaging
├── network/core/
│   └── wati.js                    # WATI API integration
└── router/routes/
    ├── dashboardRoutes.js         # Navigation menu
    └── privateRoutes.js           # Route definitions

FINAL_NURSERY_BE/
├── controllers/
│   └── msg.controller.js          # Backend message handling
└── models/
    └── broadcast.model.js         # Broadcast group management
```

---

## 🔧 **Core Components**

### **1. WATI API Integration (`wati.js`)**

**Features:**
- ✅ **Get Message Templates** - Fetch approved templates from WATI
- ✅ **Send Template Messages** - Single recipient messaging
- ✅ **Send Bulk Messages** - Campaign messaging to multiple recipients
- ✅ **Send Text Messages** - Simple text messaging
- ✅ **Get Contacts** - Fetch contact lists
- ✅ **Connection Testing** - Test WATI API connectivity

**Key Functions:**
```javascript
// Get templates
export const getMessageTemplates = async (params = {})

// Send to single number
export const sendTemplateMessage = async (messageData)

// Send to multiple numbers (campaign)
export const sendTemplateMessages = async (messageData)

// Send simple text
export const sendTextMessage = async (messageData)

// Test connection
export const testWatiConnection = async ()
```

**Configuration:**
- **Base URL**: `https://live-mt-server.wati.io/385403`
- **Authentication**: Bearer token authentication
- **Channel Number**: `917276386452`

---

### **2. WhatsApp Management Dashboard (`WhatsAppManagement.js`)**

**Features:**
- ✅ **Template Listing** - View all available templates with pagination
- ✅ **Search & Filter** - Search by name, content, status
- ✅ **Template Actions** - Send campaigns, single messages, edit, delete
- ✅ **Status Management** - Filter by approved, pending, rejected
- ✅ **Category Organization** - Organize by order, payment, information, promotion
- ✅ **Connection Testing** - Test WATI API connection

**UI Components:**
- Template table with search and filtering
- Action buttons for each template
- Status chips (approved, pending, rejected)
- Category chips (order, payment, information, promotion)
- Pagination for large template lists

---

### **3. Farmer Campaign Modal (`FarmerCampaignModal.js`)**

**Features:**
- ✅ **Farmer Selection** - Multi-select farmers with checkboxes
- ✅ **Search & Filter** - Filter by district, taluka, village
- ✅ **Template Parameters** - Dynamic parameter filling
- ✅ **Bulk Messaging** - Send to selected farmers
- ✅ **Preview System** - Preview template with parameters

**Template Parameter Support:**
- `{{farmerName}}` - Farmer's name
- `{{orderNumber}}` - Order ID
- `{{amount}}` - Payment amount
- `{{village}}` - Village name
- `{{mobile}}` - Phone number
- `{{plant}}` - Plant type
- `{{subtype}}` - Plant subtype
- `{{rate}}` - Plant rate
- `{{advance}}` - Advance payment
- `{{remaining}}` - Remaining amount
- `{{delivery}}` - Delivery date

---

### **4. Single Send Modal (`SingleSendModal.js`)**

**Features:**
- ✅ **Phone Number Input** - Enter any WhatsApp number
- ✅ **Phone Validation** - Automatic formatting (E.164)
- ✅ **Template Parameters** - Fill dynamic content
- ✅ **Language Selection** - English, Marathi, Hindi
- ✅ **Success Feedback** - Confirmation of sent messages

**Phone Number Formatting:**
- Auto-adds `91` country code for Indian numbers
- Supports various input formats
- Validates phone number format

---

### **5. Backend Message Controller (`msg.controller.js`)**

**Features:**
- ✅ **Send Messages** - Send template messages via WATI
- ✅ **Fetch Templates** - Get approved templates
- ✅ **Contact Management** - Get farmers, employees, users
- ✅ **Broadcast Groups** - Manage contact lists

**API Endpoints:**
```javascript
// Send messages
POST /api/v1/msg/send

// Get templates
GET /api/v1/msg/templates

// Get contacts
GET /api/v1/msg/contacts

// Broadcast management
GET /api/v1/msg/broadcast
POST /api/v1/msg/broadcast
DELETE /api/v1/msg/broadcast/:id
```

---

## 🚀 **How to Use**

### **1. Setup WATI API**
```javascript
// In wati.js - Update these values
const WATI_BASE_URL = "https://live-mt-server.wati.io/385403"
const WATI_TOKEN = "your_wati_token_here"
```

### **2. Access WhatsApp Management**
1. Navigate to `/u/whatsapp` in the web app
2. View available templates
3. Test connection to ensure API is working

### **3. Send Campaign Messages**
1. Click "Send Campaign" on any template
2. Select farmers using filters
3. Fill template parameters
4. Click "Send to X Farmers"

### **4. Send Single Messages**
1. Click "Send to Single Number" on any template
2. Enter phone number
3. Fill template parameters
4. Click "Send Message"

---

## 📋 **Template Management**

### **Template Structure**
```javascript
{
  elementName: "template_name",
  body: "Hello {{farmerName}}, your order {{orderNumber}} is ready!",
  status: "APPROVED",
  category: "ORDER",
  language: { code: "en" }
}
```

### **Parameter Syntax**
- Use `{{variableName}}` in templates
- Parameters are replaced with actual values
- Supports multiple parameters per template

### **Template Categories**
- **Order** - Order-related messages
- **Payment** - Payment notifications
- **Information** - General information
- **Promotion** - Marketing messages

---

## 🔐 **Environment Variables**

**Backend (.env)**
```bash
WATI_URL=https://live-mt-server.wati.io/385403
WATI_TOKEN=your_wati_bearer_token
SEND_TEMPLATE_MESSAGE_URL=https://live-mt-server.wati.io/385403/api/v1/sendTemplateMessage
```

---

## 📊 **Features Summary**

| Feature | Status | Description |
|---------|--------|-------------|
| Template Management | ✅ Working | View, search, filter templates |
| Campaign Messaging | ✅ Working | Send to multiple farmers |
| Single Messaging | ✅ Working | Send to individual numbers |
| Parameter Support | ✅ Working | Dynamic content replacement |
| Phone Validation | ✅ Working | Auto-format phone numbers |
| Connection Testing | ✅ Working | Test WATI API connectivity |
| Farmer Selection | ✅ Working | Multi-select with filters |
| Language Support | ✅ Working | English, Marathi, Hindi |
| Broadcast Groups | ✅ Working | Manage contact lists |
| Status Management | ✅ Working | Approved, pending, rejected |

---

## 🎯 **Use Cases**

### **Order Notifications**
```
Template: "Hello {{farmerName}}, your order {{orderNumber}} for {{plant}} plants is ready for delivery to {{village}}."
```

### **Payment Reminders**
```
Template: "Dear {{farmerName}}, please pay the remaining amount of {{remaining}} for order {{orderNumber}}."
```

### **Delivery Updates**
```
Template: "Your order {{orderNumber}} will be delivered on {{delivery}} to {{village}}."
```

### **Plant Information**
```
Template: "Your {{plant}} plants ({{subtype}}) are ready. Rate: {{rate}} per plant."
```

---

## 🔧 **Integration Steps**

1. **Update WATI Configuration** - Set your WATI API credentials
2. **Create Templates** - Create approved templates in WATI dashboard
3. **Test Connection** - Use the "Test Connection" button
4. **Start Messaging** - Begin sending campaigns and single messages

---

## 📱 **Mobile Integration**

The WhatsApp integration is designed for web use. For mobile app integration:

1. **API Endpoints** - Use the same backend endpoints
2. **React Native** - Adapt the WATI API calls for mobile
3. **Native Features** - Integrate with device contacts

---

## ✅ **Ready to Use**

This WhatsApp integration system is **fully functional** and ready to be deployed. All components are working and tested with the WATI API.

**Next Steps:**
1. Update WATI API credentials
2. Create approved templates in WATI
3. Test the connection
4. Start sending messages to farmers!

---

*Last Updated: January 2025*
*Status: Fully Working*
