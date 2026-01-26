# 🌾 Ram Agri Sales Order Flow - Complete Documentation

## 📋 Overview

This document describes the complete flow for **Ram Agri Sales Orders** - a simplified order management system for inventory products sold by employees. Orders are connected directly to inventory, and stock is automatically deducted when orders are accepted.

---

## 🔧 Backend Implementation

### 1. **Database Models**

#### **InventoryProduct Model** (`models/inventory.model.js`)
- Added `isAgriSales` flag (Boolean, default: false)
- Products with `isAgriSales: true` are available for Agri Sales orders
- UOM (Unit of Measurement) already exists: `kg`, `g`, `l`, `ml`, `pieces`, `packets`, `bottles`, `bags`

#### **AgriSalesOrder Model** (`models/agriSalesOrder.model.js`)
```javascript
{
  orderNumber: String (auto-generated: AGR-YYYYMMDD-0001),
  customerName: String (required),
  customerMobile: String (required, 10 digits),
  customerVillage, customerTaluka, customerDistrict, customerState: String,
  productId: ObjectId (ref: InventoryProduct, required),
  productName: String (required),
  quantity: Number (required, min: 1),
  unit: String (required, enum: ["kg", "g", "l", "ml", "pieces", "packets", "bottles", "bags"]),
  rate: Number (required, min: 0),
  totalAmount: Number (calculated: quantity * rate),
  orderStatus: String (enum: ["PENDING", "ACCEPTED", "REJECTED", "COMPLETED", "CANCELLED"], default: "PENDING"),
  payment: [paymentSchema],
  paymentStatus: String (enum: ["PENDING", "PARTIAL", "COMPLETED"], default: "PENDING"),
  totalPaidAmount: Number (default: 0),
  balanceAmount: Number (calculated: totalAmount - totalPaidAmount),
  orderDate: Date (required, default: Date.now),
  deliveryDate: Date (optional),
  createdBy: ObjectId (ref: User, required),
  acceptedBy: ObjectId (ref: User, optional),
  acceptedAt: Date (optional),
  stockDeducted: Boolean (default: false),
  stockDeductedAt: Date (optional),
  notes: String (optional),
  remarks: [String],
  screenshots: [String] (Cloudinary URLs)
}
```

### 2. **API Endpoints**

All endpoints are under `/api/v1/inventory/agri-sales-orders`:

#### **Customer Lookup**
```
GET /api/v1/inventory/agri-sales-orders/customer/:mobileNumber
```
- Auto-fill customer data from mobile number
- Returns: customer name, location (village, taluka, district, state)
- Searches Farmer collection first

#### **Create Order**
```
POST /api/v1/inventory/agri-sales-orders/create
```
- Creates a new Agri Sales order
- Validates:
  - Customer name, mobile (10 digits), product, quantity, rate are required
  - Product must have `isAgriSales: true`
  - Stock availability is checked (but NOT deducted yet)
- Order status: `PENDING`
- Returns: Created order with populated product and createdBy

#### **Accept Order (Deduct Stock)**
```
PATCH /api/v1/inventory/agri-sales-orders/:id/accept
```
- **IMPORTANT**: This is when stock is deducted
- Validates:
  - Order status must be `PENDING`
  - Stock availability is checked again
- Actions:
  - Deducts `quantity` from `product.currentStock`
  - Sets `orderStatus` to `ACCEPTED`
  - Sets `stockDeducted: true`
  - Records `acceptedBy` and `acceptedAt`
- Returns: Updated order

#### **Reject Order**
```
PATCH /api/v1/inventory/agri-sales-orders/:id/reject
```
- Sets `orderStatus` to `REJECTED`
- Optionally accepts `reason` in body
- **Does NOT deduct stock**

#### **Get All Orders**
```
GET /api/v1/inventory/agri-sales-orders
```
Query Parameters:
- `search`: Search by customer name, mobile, order number, product name
- `orderStatus`: Filter by status (PENDING, ACCEPTED, REJECTED, COMPLETED, CANCELLED)
- `paymentStatus`: Filter by payment status (PENDING, PARTIAL, COMPLETED)
- `productId`: Filter by product
- `customerMobile`: Filter by customer mobile
- `startDate`, `endDate`: Filter by order date (YYYY-MM-DD)
- `page`, `limit`: Pagination
- `sortKey`, `sortOrder`: Sorting

#### **Get Order By ID**
```
GET /api/v1/inventory/agri-sales-orders/:id
```
- Returns single order with populated fields

#### **Add Payment**
```
PATCH /api/v1/inventory/agri-sales-orders/:id/payment
```
Body:
```json
{
  "paidAmount": Number (required),
  "paymentDate": "YYYY-MM-DD" (required),
  "modeOfPayment": "Cash|UPI|Cheque|NEFT/RTGS|1341|434|Wallet" (required if not wallet),
  "bankName": String (optional, for Cheque/NEFT),
  "receiptPhoto": [String] (Cloudinary URLs, required for UPI/Cheque/1341/434),
  "remark": String (optional),
  "isWalletPayment": Boolean (default: false)
}
```
- Adds payment to order
- Updates `totalPaidAmount` and `balanceAmount`
- Updates `paymentStatus` (PENDING → PARTIAL → COMPLETED)

#### **Update Payment Status**
```
PATCH /api/v1/inventory/agri-sales-orders/:id/payment/:paymentIndex/status
```
Body:
```json
{
  "paymentStatus": "COLLECTED|REJECTED|PENDING"
}
```
- Updates status of a specific payment entry

### 3. **Product Management**

#### **Filter Products for Agri Sales**
```
GET /api/v1/inventory/products?isAgriSales=true&isActive=true
```
- Returns only products available for Agri Sales orders

#### **Update Product to Enable Agri Sales**
```
PATCH /api/v1/inventory/products/:id
```
Body:
```json
{
  "isAgriSales": true
}
```
- Sets product as available for Agri Sales orders

---

## 🎨 Frontend Implementation

### 1. **Mobile-Friendly Add Order Form**

**Component**: `AddAgriSalesOrderForm.jsx`

**Features**:
- ✅ **Responsive Design**: Mobile-friendly layout with Material-UI components
- ✅ **Auto-fill from Mobile**: Enter 10-digit mobile → auto-fills customer name and location
- ✅ **Product Selection**: Only shows products with `isAgriSales: true`
- ✅ **Stock Validation**: Real-time stock availability check
- ✅ **Payment Management**: Same flow as AddOrderForm (Cash, UPI, Cheque, etc.)
- ✅ **Image Upload**: Payment receipt photos (Cloudinary integration)
- ✅ **UOM Display**: Shows unit of measurement (kg, g, l, ml, pieces, etc.)

**Form Fields**:
1. **Customer Information**:
   - Mobile Number (10 digits, auto-fill enabled)
   - Customer Name (auto-filled if found)
   - Village, Taluka, District (auto-filled if found)
   - State (default: Maharashtra)

2. **Product Information**:
   - Select Product (only `isAgriSales: true` products)
   - Quantity (with unit display)
   - Rate (auto-filled from product sellingPrice, editable)
   - Total Amount (calculated)

3. **Order Details**:
   - Order Date (default: today)
   - Delivery Date (optional)
   - Notes (optional)

4. **Payment Information** (Optional):
   - Paid Amount
   - Payment Date
   - Payment Mode (Cash, UPI, Cheque, NEFT/RTGS, 1341, 434)
   - Bank Name (for Cheque/NEFT)
   - Payment Remark
   - Receipt Photos (required for non-Cash payments except NEFT/RTGS)

### 2. **Order Table Integration**

**Component**: `FarmerOrdersTable.js`

**Toggle Button**: "Ram Agri Sales" toggle in header
- Switches between Regular Orders and Agri Sales Orders
- Shows different status tabs for each type

**Status Tabs for Agri Sales**:
- **Pending**: Orders with status `PENDING`
- **Accepted**: Orders with status `ACCEPTED` (stock already deducted)
- **Completed**: Orders with status `COMPLETED`

**Actions Available**:
- ✅ **Accept Order**: Click status → "ACCEPTED" → Stock deducted automatically
- ✅ **Reject Order**: Click status → "REJECTED" → No stock deduction
- ✅ **Add Payment**: Same as regular orders
- ✅ **View Details**: Customer info, product, payment history

**Filters**:
- Customer Mobile Number
- Village, District
- Order Status
- Payment Status
- Date Range
- Product (when viewing Agri Sales orders)

---

## 🔄 Complete Flow

### **Flow 1: Employee Places Order**

1. **Navigate to Orders Table**
   - Go to Dashboard → Orders
   - Toggle to "Ram Agri Sales" mode

2. **Click "Add Order" Button**
   - Opens `AddAgriSalesOrderForm` dialog

3. **Enter Customer Mobile Number**
   - Enter 10-digit mobile number
   - If customer exists in Farmer database → Auto-fills name and location
   - If not found → Manual entry

4. **Select Product**
   - Dropdown shows only products with `isAgriSales: true`
   - Each product shows: Name, Category, Current Stock, Unit
   - Rate auto-fills from product `sellingPrice`

5. **Enter Quantity**
   - Validates against available stock
   - Shows warning if insufficient stock
   - Displays unit of measurement (UOM)

6. **Optional: Add Payment**
   - Enter payment amount, date, mode
   - Upload receipt photos (for non-Cash payments)
   - Payment can be added later if skipped

7. **Submit Order**
   - Creates order with status: `PENDING`
   - Order number auto-generated: `AGR-YYYYMMDD-0001`
   - **Stock is NOT deducted yet**

### **Flow 2: Accept Order & Deduct Stock**

1. **View Pending Orders**
   - Switch to "Pending" tab (Agri Sales mode)
   - See all orders with status `PENDING`

2. **Accept Order**
   - Click on order status dropdown
   - Select "ACCEPTED"
   - Confirm action
   - **Backend automatically**:
     - Validates stock availability
     - Deducts quantity from `product.currentStock`
     - Sets `orderStatus` to `ACCEPTED`
     - Records `acceptedBy` and `acceptedAt`
     - Sets `stockDeducted: true`

3. **Result**
   - Order moves to "Accepted" tab
   - Inventory stock is reduced
   - Order cannot be rejected after acceptance

### **Flow 3: Add Payment to Order**

1. **Select Order**
   - Click on any order (Pending or Accepted)

2. **Click "Add Payment"**
   - Opens payment form (same as regular orders)

3. **Enter Payment Details**
   - Amount, Date, Mode
   - Upload receipt photos if required
   - Bank name for Cheque/NEFT

4. **Submit Payment**
   - Payment added to order
   - `totalPaidAmount` and `balanceAmount` updated
   - `paymentStatus` updated (PENDING → PARTIAL → COMPLETED)

5. **Update Payment Status** (Optional)
   - Click on payment entry
   - Update status: COLLECTED, REJECTED, PENDING

### **Flow 4: Reject Order**

1. **View Pending Order**
   - Find order with status `PENDING`

2. **Reject Order**
   - Click status dropdown
   - Select "REJECTED"
   - Optionally enter reason
   - **Stock is NOT deducted**

3. **Result**
   - Order status: `REJECTED`
   - Stock remains unchanged
   - Order cannot be accepted after rejection

---

## 🧪 Testing Checklist

### **Backend Testing**

1. ✅ **Product Management**
   - [ ] Create product with `isAgriSales: true`
   - [ ] Update product to enable `isAgriSales`
   - [ ] Filter products by `isAgriSales=true`
   - [ ] Verify UOM is maintained (kg, g, l, ml, pieces, etc.)

2. ✅ **Customer Lookup**
   - [ ] GET `/customer/:mobileNumber` with existing farmer → Returns data
   - [ ] GET `/customer/:mobileNumber` with non-existing → Returns 404

3. ✅ **Order Creation**
   - [ ] POST `/create` with valid data → Order created, status: PENDING
   - [ ] POST `/create` with invalid mobile → Error 400
   - [ ] POST `/create` with non-AgriSales product → Error 400
   - [ ] POST `/create` with insufficient stock → Error 400
   - [ ] POST `/create` with payment → Payment included

4. ✅ **Accept Order (Stock Deduction)**
   - [ ] PATCH `/:id/accept` with sufficient stock → Stock deducted, status: ACCEPTED
   - [ ] PATCH `/:id/accept` with insufficient stock → Error 400
   - [ ] PATCH `/:id/accept` on non-PENDING order → Error 400
   - [ ] Verify `product.currentStock` is reduced

5. ✅ **Reject Order**
   - [ ] PATCH `/:id/reject` → Status: REJECTED
   - [ ] Verify stock is NOT deducted

6. ✅ **Payment Management**
   - [ ] PATCH `/:id/payment` → Payment added
   - [ ] Verify `totalPaidAmount` and `balanceAmount` updated
   - [ ] PATCH `/:id/payment/:index/status` → Payment status updated

7. ✅ **List Orders**
   - [ ] GET `/` → Returns all orders
   - [ ] GET `/?orderStatus=PENDING` → Returns only pending
   - [ ] GET `/?customerMobile=1234567890` → Filters by mobile
   - [ ] GET `/?startDate=2025-01-01&endDate=2025-01-31` → Date range filter

### **Frontend Testing**

1. ✅ **Add Order Form**
   - [ ] Open form → Products load (only `isAgriSales: true`)
   - [ ] Enter mobile → Auto-fills customer data
   - [ ] Select product → Rate auto-fills, stock displayed
   - [ ] Enter quantity > stock → Shows error
   - [ ] Add payment → Upload images works
   - [ ] Submit → Order created successfully

2. ✅ **Order Table**
   - [ ] Toggle "Ram Agri Sales" → Shows Agri Sales orders
   - [ ] Toggle "Regular Orders" → Shows regular orders
   - [ ] Click "Add Order" → Opens form
   - [ ] View Pending tab → Shows PENDING orders
   - [ ] View Accepted tab → Shows ACCEPTED orders
   - [ ] Filters work (village, district, status, date range)

3. ✅ **Order Actions**
   - [ ] Accept order → Stock deducted, status: ACCEPTED
   - [ ] Reject order → Status: REJECTED, stock unchanged
   - [ ] Add payment → Payment added successfully
   - [ ] View order details → Shows correct information

---

## 📊 Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    EMPLOYEE ACTIONS                          │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  1. TOGGLE "RAM AGRI SALES" IN FARMERORDERS TABLE           │
│     - Switches view to Agri Sales orders                    │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  2. CLICK "ADD ORDER" BUTTON                                │
│     - Opens AddAgriSalesOrderForm dialog                    │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  3. ENTER MOBILE NUMBER (10 digits)                         │
│     → GET /customer/:mobileNumber                           │
│     → Auto-fills: name, village, taluka, district, state    │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  4. SELECT PRODUCT                                          │
│     → GET /products?isAgriSales=true&isActive=true          │
│     → Shows: Name, Category, Stock, Unit                    │
│     → Auto-fills rate from product.sellingPrice             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  5. ENTER QUANTITY & VALIDATE STOCK                         │
│     - Checks: quantity <= product.currentStock              │
│     - Shows error if insufficient                           │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  6. OPTIONAL: ADD PAYMENT                                   │
│     - Amount, Date, Mode, Receipt Photos                    │
│     - Validates: Image required for UPI/Cheque/1341/434     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  7. SUBMIT ORDER                                            │
│     → POST /agri-sales-orders/create                        │
│     → Order created with status: PENDING                    │
│     → Stock: NOT deducted yet                               │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  8. VIEW ORDER IN "PENDING" TAB                             │
│     → Shows all PENDING orders                              │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  9. ACCEPT ORDER                                            │
│     → PATCH /agri-sales-orders/:id/accept                   │
│     → Validates stock again                                 │
│     → DEDUCTS STOCK: product.currentStock -= quantity       │
│     → Updates: orderStatus = ACCEPTED                       │
│     → Records: acceptedBy, acceptedAt, stockDeducted = true │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  10. ORDER MOVES TO "ACCEPTED" TAB                          │
│      → Stock is deducted                                    │
│      → Order can receive payments                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔑 Key Points

1. **Stock Deduction Timing**: Stock is deducted **ONLY** when order status changes to `ACCEPTED`, not when order is created.

2. **UOM Maintained**: Unit of Measurement (kg, g, l, ml, pieces, packets, bottles, bags) is preserved throughout the flow.

3. **Product Filtering**: Only products with `isAgriSales: true` appear in the form.

4. **Auto-fill**: Customer data auto-fills from mobile number (searches Farmer collection).

5. **Payment Flow**: Same as regular orders - supports Cash, UPI, Cheque, NEFT/RTGS, 1341, 434. Images required for non-Cash payments (except NEFT/RTGS).

6. **Status Flow**: PENDING → ACCEPTED (deduct stock) → COMPLETED or REJECTED (no stock deduction)

7. **Mobile-Friendly**: Form is responsive and works on mobile devices.

---

## 🐛 Known Issues / Future Enhancements

1. ✅ All functionality implemented
2. ⚠️ Consider adding batch selection for Agri Sales orders (if needed)
3. ⚠️ Consider adding delivery tracking (if needed)
4. ⚠️ Consider adding order cancellation with stock reversal (if needed)

---

## 📝 API Response Examples

### Create Order Response
```json
{
  "status": "Success",
  "message": "Agri Sales Order created successfully",
  "data": {
    "orderNumber": "AGR-20250115-0001",
    "customerName": "John Doe",
    "customerMobile": "9876543210",
    "productName": "Fertilizer A",
    "quantity": 10,
    "unit": "kg",
    "rate": 500,
    "totalAmount": 5000,
    "orderStatus": "PENDING",
    "paymentStatus": "PENDING",
    "stockDeducted": false
  }
}
```

### Accept Order Response
```json
{
  "status": "Success",
  "message": "Order accepted and stock deducted successfully",
  "data": {
    "orderNumber": "AGR-20250115-0001",
    "orderStatus": "ACCEPTED",
    "stockDeducted": true,
    "stockDeductedAt": "2025-01-15T10:30:00.000Z",
    "acceptedBy": "userId123",
    "acceptedAt": "2025-01-15T10:30:00.000Z"
  }
}
```

---

## 🚀 Deployment Checklist

- [x] Backend models created and exported
- [x] Backend controllers implemented
- [x] Backend routes registered in app.js
- [x] Frontend API endpoints added to endpoints.js
- [x] Frontend form component created
- [x] Frontend table toggle implemented
- [x] Stock deduction logic tested
- [x] Payment flow integrated
- [ ] Manual testing on staging
- [ ] Deploy to production

---

**Last Updated**: 2025-01-15
**Version**: 1.0.0


