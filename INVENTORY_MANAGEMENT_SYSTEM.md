# 🏪 Inventory Management System

A comprehensive inventory management system for the nursery management application with full CRUD operations, batch tracking, inward/outward transactions, and real-time analytics.

## 📋 Table of Contents

- [Features](#-features)
- [System Architecture](#-system-architecture)
- [Database Models](#-database-models)
- [API Endpoints](#-api-endpoints)
- [Frontend Interface](#-frontend-interface)
- [Installation & Setup](#-installation--setup)
- [Usage Guide](#-usage-guide)
- [API Documentation](#-api-documentation)

## ✨ Features

### 🎯 Core Features
- **Product Management**: Complete CRUD operations for inventory products
- **Batch Tracking**: Track products by batches with expiry dates and manufacturing info
- **Inward Transactions**: Record stock received from suppliers
- **Outward Transactions**: Record stock issued to customers or internal use
- **Stock Adjustments**: Handle stock corrections, damages, and adjustments
- **Real-time Dashboard**: Analytics and key metrics overview

### 🔍 Advanced Features
- **Search & Filtering**: Real-time search across all inventory items
- **Pagination**: Efficient data loading for large datasets
- **Status Tracking**: Active/inactive products, batch status, transaction status
- **Supplier Management**: Track supplier information for each product/batch
- **Customer Management**: Record customer details for outward transactions
- **Stock Level Alerts**: Monitor minimum stock levels
- **Transaction History**: Complete audit trail of all inventory movements

### 🎨 User Interface
- **Tabbed Interface**: Organized sections for different inventory operations
- **Modern Design**: Material-UI components with responsive layout
- **Modal Forms**: Clean and intuitive data entry forms
- **Status Indicators**: Visual chips and badges for status tracking
- **Real-time Updates**: Live data refresh and loading states

## 🏗️ System Architecture

### Backend (Node.js + Express + MongoDB)
```
models/
├── inventory.model.js          # All inventory-related schemas
├── Product                     # Product management
├── InventoryBatch             # Batch tracking
├── InventoryInward            # Inward transactions
├── InventoryOutward           # Outward transactions
└── StockAdjustment            # Stock adjustments

controllers/
└── inventory.controller.js     # Business logic for all operations

routes/
└── inventory.route.js         # API endpoint definitions
```

### Frontend (React + Material-UI)
```
pages/private/inventory/
└── index.jsx                  # Main inventory interface with tabs
```

## 🗄️ Database Models

### Product Schema
```javascript
{
  name: String,                 // Product name
  description: String,          // Product description
  category: String,             // Seeds, Fertilizers, Chemicals, etc.
  unit: String,                 // kg, g, l, ml, pieces, etc.
  minStockLevel: Number,        // Minimum stock threshold
  maxStockLevel: Number,        // Maximum stock capacity
  currentStock: Number,         // Current available stock
  costPrice: Number,            // Purchase cost
  sellingPrice: Number,         // Selling price
  supplier: {                   // Supplier information
    name: String,
    contact: String,
    email: String
  },
  isActive: Boolean,            // Product status
  image: String,                // Product image URL
  tags: [String]                // Product tags
}
```

### InventoryBatch Schema
```javascript
{
  productId: ObjectId,          // Reference to Product
  batchNumber: String,          // Unique batch identifier
  quantity: Number,             // Total batch quantity
  receivedQuantity: Number,     // Quantity received
  remainingQuantity: Number,    // Quantity remaining
  manufacturingDate: Date,      // Manufacturing date
  expiryDate: Date,             // Expiry date
  costPrice: Number,            // Batch cost price
  supplier: Object,             // Supplier information
  receivedDate: Date,           // Date received
  receivedBy: ObjectId,         // User who received
  status: String,               // active, expired, depleted
  notes: String                 // Additional notes
}
```

### InventoryInward Schema
```javascript
{
  productId: ObjectId,          // Reference to Product
  batchId: ObjectId,            // Reference to Batch
  quantity: Number,             // Quantity received
  costPrice: Number,            // Cost per unit
  totalAmount: Number,          // Total transaction amount
  supplier: Object,             // Supplier information
  invoiceNumber: String,        // Invoice reference
  receivedDate: Date,           // Date received
  receivedBy: ObjectId,         // User who received
  notes: String,                // Additional notes
  status: String                // pending, received, cancelled
}
```

### InventoryOutward Schema
```javascript
{
  productId: ObjectId,          // Reference to Product
  batchId: ObjectId,            // Reference to Batch (optional)
  quantity: Number,             // Quantity issued
  sellingPrice: Number,         // Selling price per unit
  totalAmount: Number,          // Total transaction amount
  customer: Object,             // Customer information
  purpose: String,              // sale, internal_use, damaged, etc.
  destination: String,          // customer, internal, disposal, transfer
  outwardDate: Date,            // Date issued
  issuedBy: ObjectId,           // User who issued
  notes: String,                // Additional notes
  status: String                // pending, issued, cancelled
}
```

## 🔌 API Endpoints

### Products
- `POST /api/v1/inventory/products/create` - Create new product
- `GET /api/v1/inventory/products/all` - Get all products with pagination
- `GET /api/v1/inventory/products/:id` - Get product by ID
- `PATCH /api/v1/inventory/products/:id` - Update product
- `DELETE /api/v1/inventory/products/:id` - Delete product
- `PATCH /api/v1/inventory/products/:id/toggle-status` - Toggle product status

### Batches
- `POST /api/v1/inventory/batches/create` - Create new batch
- `GET /api/v1/inventory/batches/all` - Get all batches with pagination

### Inwards
- `POST /api/v1/inventory/inwards/create` - Create inward transaction
- `GET /api/v1/inventory/inwards/all` - Get all inward transactions

### Outwards
- `POST /api/v1/inventory/outwards/create` - Create outward transaction
- `GET /api/v1/inventory/outwards/all` - Get all outward transactions

### Stock Adjustments
- `POST /api/v1/inventory/adjustments/create` - Create stock adjustment

### Dashboard
- `GET /api/v1/inventory/dashboard` - Get dashboard analytics

## 🖥️ Frontend Interface

### Tab Structure
1. **Dashboard** - Overview with key metrics and recent transactions
2. **Products** - Product management with CRUD operations
3. **Batches** - Batch tracking and management
4. **Inwards** - Inward transaction history
5. **Outwards** - Outward transaction history

### Key Components
- **Search Bar**: Real-time search across all data
- **Action Buttons**: Add new items with modal forms
- **Data Tables**: Sortable and filterable data display
- **Status Chips**: Visual status indicators
- **Modal Dialogs**: Form-based data entry
- **Loading States**: User feedback during operations

## 🚀 Installation & Setup

### Prerequisites
- Node.js (v14 or higher)
- MongoDB (v4.4 or higher)
- React development environment

### Backend Setup
1. Navigate to the backend directory:
   ```bash
   cd FINAL_NURSERY_BE
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   npm start
   ```

The server will run on `http://localhost:8000`

### Frontend Setup
1. Navigate to the frontend directory:
   ```bash
   cd nursery-mgmt
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm start
   ```

The frontend will run on `http://localhost:3000`

## 📖 Usage Guide

### 1. Adding a Product
1. Navigate to the Inventory section
2. Click on the "Products" tab
3. Click "Add Product" button
4. Fill in the product details:
   - Name, description, category
   - Unit, cost price, selling price
   - Minimum stock level
   - Supplier information
5. Click "Create" to save

### 2. Creating a Batch
1. Go to the "Batches" tab
2. Click "Add Batch" button
3. Select the product
4. Enter batch details:
   - Batch number
   - Quantity and cost price
   - Manufacturing and expiry dates
   - Supplier information
5. Click "Create" to save

### 3. Recording Inward Transaction
1. Go to the "Inwards" tab
2. Click "Add Inward" button
3. Select product and batch
4. Enter transaction details:
   - Quantity received
   - Cost price
   - Invoice number
   - Supplier information
5. Click "Create" to save

### 4. Recording Outward Transaction
1. Go to the "Outwards" tab
2. Click "Add Outward" button
3. Select product (and batch if applicable)
4. Enter transaction details:
   - Quantity issued
   - Purpose and destination
   - Customer information
   - Selling price
5. Click "Create" to save

### 5. Viewing Dashboard
1. The dashboard tab shows:
   - Total products count
   - Active products count
   - Low stock items count
   - Total stock value
   - Recent inward transactions
   - Recent outward transactions

## 📚 API Documentation

### Authentication
All inventory endpoints require JWT authentication. Include the token in the Authorization header:
```
Authorization: Bearer <your-jwt-token>
```

### Response Format
All API responses follow a standard format:
```javascript
{
  "status": "success" | "error",
  "message": "Response message",
  "data": {}, // Response data
  "error": null // Error details if any
}
```

### Pagination
List endpoints support pagination with query parameters:
- `page`: Page number (default: 1)
- `limit`: Items per page (default: 10)
- `sortKey`: Sort field (default: createdAt)
- `sortOrder`: Sort direction (asc/desc, default: desc)

### Search
List endpoints support search with the `search` query parameter for text-based filtering.

### Error Handling
The API returns appropriate HTTP status codes:
- `200`: Success
- `201`: Created
- `400`: Bad Request
- `401`: Unauthorized
- `404`: Not Found
- `409`: Conflict
- `500`: Internal Server Error

## 🔧 Configuration

### Environment Variables
```bash
# Database
MONGODB_URI=mongodb://localhost:27017/nursery_db

# JWT
JWT_SECRET=your-jwt-secret

# Server
PORT=8000
NODE_ENV=development
```

### Customization
- **Product Categories**: Modify the enum in the Product schema
- **Units**: Update the unit options in the Product schema
- **Transaction Purposes**: Customize purpose and destination options
- **Stock Adjustment Reasons**: Modify the reason enum in StockAdjustment schema

## 🧪 Testing

Run the test script to verify the system:
```bash
cd FINAL_NURSERY_BE
node test-inventory.js
```

## 🐛 Troubleshooting

### Common Issues
1. **Authentication Error**: Ensure JWT token is valid and included in headers
2. **Database Connection**: Check MongoDB connection string and database status
3. **CORS Issues**: Verify CORS configuration in backend
4. **Port Conflicts**: Ensure ports 8000 (backend) and 3000 (frontend) are available

### Debug Mode
Enable debug logging by setting:
```bash
NODE_ENV=development
DEBUG=inventory:*
```

## 📈 Future Enhancements

- **Barcode Integration**: QR code generation and scanning
- **Email Notifications**: Low stock alerts and expiry notifications
- **Advanced Analytics**: Detailed reports and forecasting
- **Mobile App**: React Native mobile application
- **Multi-location Support**: Multiple warehouse management
- **Integration**: ERP system integration
- **Export Features**: PDF reports and Excel exports

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

This project is part of the Nursery Management System and follows the same licensing terms.

---

**🎉 The Inventory Management System is now fully operational and ready for production use!** 