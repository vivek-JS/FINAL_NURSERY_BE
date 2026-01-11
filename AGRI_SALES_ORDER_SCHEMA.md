# Agri Sales Order - Separate Schema & Model Documentation

## Overview
The Agri Sales Order system uses a **completely separate schema and model** (`AgriSalesOrder`) from the regular farmer orders, designed specifically for Ram Agri Sales employees to place orders.

## Model Location
- **File**: `/FINAL_NURSERY_BE/models/agriSalesOrder.model.js`
- **Collection Name**: `agrisalesorders` (MongoDB)
- **Model Name**: `AgriSalesOrder`

## Schema Structure

### 1. Order Identification
```javascript
orderNumber: String (unique, auto-generated)
// Format: AGR-YYMMDD-001 (e.g., AGR-260110-001)
// Generated automatically before save using date-based sequential numbering
```

### 2. Customer Information
```javascript
customerName: String (required)
customerMobile: String (required, 10 digits)
customerVillage: String (optional)
customerTaluka: String (optional)
customerDistrict: String (optional)
customerState: String (default: "Maharashtra")
```

### 3. Product Information
```javascript
productId: ObjectId (ref: "InventoryProduct", required)
productName: String (required, auto-filled from product)
quantity: Number (required, min: 1)
unit: String (required, enum: ["kg", "g", "l", "ml", "pieces", "packets", "bottles", "bags"])
rate: Number (required, min: 0)
totalAmount: Number (required, auto-calculated: quantity * rate)
```

### 4. Order Status
```javascript
orderStatus: String (enum: ["PENDING", "ACCEPTED", "REJECTED", "COMPLETED", "CANCELLED"])
// Default: "PENDING"
// Status flow: PENDING → ACCEPTED/REJECTED → COMPLETED
```

### 5. Payment Information (Array)
```javascript
payment: [{
  paidAmount: Number (required, min: 0)
  paymentStatus: String (enum: ["COLLECTED", "REJECTED", "PENDING"], default: "PENDING")
  paymentDate: Date (required, default: Date.now)
  bankName: String (optional)
  receiptPhoto: [String] (Cloudinary URLs)
  modeOfPayment: String (enum: ["Cash", "UPI", "Cheque", "NEFT/RTGS", "1341", "434", "Wallet"])
  remark: String (optional)
  isWalletPayment: Boolean (default: false)
}]

paymentStatus: String (enum: ["PENDING", "PARTIAL", "COMPLETED"])
// Auto-calculated based on payment array
totalPaidAmount: Number (auto-calculated, only from COLLECTED payments)
balanceAmount: Number (auto-calculated: totalAmount - totalPaidAmount)
```

### 6. User-Wise Tracking (Employee Tracking)
```javascript
// Employee who created the order
createdBy: ObjectId (ref: "User", required)
// Populated with user details (name, phoneNumber, role, etc.)

// Employee who accepted the order (for stock deduction)
acceptedBy: ObjectId (ref: "User", optional)
acceptedAt: Date (optional)

// Stock deduction tracking
stockDeducted: Boolean (default: false)
stockDeductedAt: Date (optional)
```

### 7. Order Details
```javascript
orderDate: Date (required, default: Date.now)
deliveryDate: Date (optional)
notes: String (optional)
remarks: [String] (optional array)
screenshots: [String] (Cloudinary URLs, optional)
```

### 8. Timestamps
```javascript
createdAt: Date (auto-generated)
updatedAt: Date (auto-updated)
```

## Indexes (For Performance)

### Single Field Indexes
- `orderNumber` (unique) - Auto-created by `unique: true`
- `customerMobile` - For customer lookup
- `productId` - For product-based queries
- `orderStatus` - For status filtering
- `createdBy` - **For user-wise filtering** (employee who created)
- `acceptedBy` - For employee who accepted
- `orderDate` - For date-based sorting
- `paymentStatus` - For payment filtering
- `stockDeducted` - For stock deduction tracking
- `createdAt` - For creation time sorting

### Compound Indexes
- `{ createdBy: 1, orderStatus: 1 }` - User's orders by status
- `{ orderDate: 1, orderStatus: 1 }` - Date and status filtering
- `{ customerMobile: 1, orderDate: -1 }` - Customer orders by date

## Virtual Fields

### paymentSummary
Automatically calculated payment summary:
```javascript
{
  totalPaid: Number,
  totalPending: Number,
  totalRejected: Number,
  count: Number
}
```

## Pre-Save Hooks

### 1. Order Number Generation
- Automatically generates unique order number: `AGR-YYMMDD-001`
- Date-based sequential numbering (resets daily)
- Prevents duplicates using date prefix

### 2. Total Amount & Balance Calculation
- Automatically calculates `totalAmount = quantity * rate`
- Automatically calculates `balanceAmount = totalAmount - totalPaidAmount`
- Automatically updates `paymentStatus` based on payment array

## API Endpoints

### Create Order
```
POST /api/v1/inventory/agri-sales-orders/create
```
**Required Fields:**
- `customerName`, `customerMobile`, `productId`, `quantity`, `rate`
- `createdBy` - Automatically set from authenticated user

### Get All Orders (User-Wise Filtering)
```
GET /api/v1/inventory/agri-sales-orders?myOrders=true&orderStatus=PENDING
```
**Query Parameters:**
- `myOrders=true` - Show only orders created by current user
- `createdBy=<userId>` - Show orders created by specific employee
- `orderStatus` - Filter by status
- `paymentStatus` - Filter by payment status
- `productId` - Filter by product
- `customerMobile` - Filter by customer
- `startDate`, `endDate` - Filter by date range
- `search` - Search by customer name, mobile, order number, or product name
- `page`, `limit` - Pagination

### Get Order by ID
```
GET /api/v1/inventory/agri-sales-orders/:id
```

### Accept Order & Deduct Stock
```
PATCH /api/v1/inventory/agri-sales-orders/:id/accept
```
- Changes status to "ACCEPTED"
- Deducts stock from InventoryProduct
- Sets `acceptedBy` and `acceptedAt`
- Sets `stockDeducted = true`

### Reject Order
```
PATCH /api/v1/inventory/agri-sales-orders/:id/reject
```

### Add Payment
```
PATCH /api/v1/inventory/agri-sales-orders/:id/payment
```

### Update Payment Status
```
PATCH /api/v1/inventory/agri-sales-orders/:id/payment/:paymentIndex/status
```

## User-Wise Features

### 1. Employee Order Creation
- Every order **must** have a `createdBy` field (automatically set from authenticated user)
- Users can only see their own orders when using `myOrders=true` parameter

### 2. Admin/Manager View
- Can view all orders
- Can filter by specific employee using `createdBy=<userId>`
- Can filter by `orderStatus`, `paymentStatus`, date ranges, etc.

### 3. Order Acceptance
- Only authorized users can accept orders
- Tracks which employee accepted (`acceptedBy`)
- Tracks when stock was deducted (`stockDeductedAt`)

## Example: Creating an Order (Curl)

```bash
curl 'http://localhost:8000/api/v1/inventory/agri-sales-orders/create' \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "customerName": "Kiran chaudhari",
    "customerMobile": "9823832132",
    "customerVillage": "Abit Khind",
    "customerTaluka": "Akola",
    "customerDistrict": "Ahmadnagar",
    "customerState": "Maharashtra",
    "productId": "69627adc73d05dab8854e074",
    "quantity": 12,
    "rate": 35,
    "orderDate": "2026-01-10T16:24:42.931Z",
    "deliveryDate": "2026-01-21T18:30:00.000Z",
    "notes": "",
    "payment": [{
      "paidAmount": 123,
      "paymentDate": "2026-01-10",
      "modeOfPayment": "Cash",
      "bankName": "",
      "receiptPhoto": [],
      "remark": "Kiran chaudhari",
      "isWalletPayment": false,
      "paymentStatus": "PENDING"
    }]
  }'
```

**Response:**
```json
{
  "status": "Success",
  "message": "Agri Sales Order created successfully",
  "data": {
    "_id": "...",
    "orderNumber": "AGR-260110-001",
    "customerName": "Kiran chaudhari",
    "createdBy": {
      "_id": "...",
      "name": "Employee Name",
      "phoneNumber": 7588686452
    },
    "orderStatus": "PENDING",
    "paymentStatus": "PARTIAL",
    "totalAmount": 420,
    "totalPaidAmount": 123,
    "balanceAmount": 297,
    ...
  }
}
```

## Key Features

✅ **Separate Schema** - Completely independent from farmer orders
✅ **User-Wise Tracking** - Every order tracks which employee created it
✅ **Auto-Generated Order Numbers** - Date-based sequential numbering
✅ **Auto-Calculated Fields** - Total amount, balance, payment status
✅ **Stock Integration** - Links to InventoryProduct model
✅ **Payment Management** - Supports multiple payments with receipts
✅ **Status Workflow** - PENDING → ACCEPTED/REJECTED → COMPLETED
✅ **Comprehensive Indexing** - Optimized for common queries
✅ **Virtual Fields** - Payment summary automatically calculated
✅ **Timestamps** - Created/updated timestamps for audit trail


