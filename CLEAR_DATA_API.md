# Clear Data API Usage Guide

## Overview
This API provides endpoints to clear various types of data from the system. **WARNING: These operations are destructive and cannot be undone.**

## Available Endpoints

### 1. Clear All Data
Deletes all orders, slots, dealers, employees, farmers, and all related data from the system.

**Endpoint:** `DELETE /api/v1/clear-data/clear-all`

**Authentication:** Required (JWT token)

**What it deletes:**
- All Dispatches
- All Orders
- All Dealer Orders
- All Dealer Bookings
- All Dealer Wallets
- All Slots
- All Plant Outward Records
- All Sowing Records
- All Attendance Records
- All Lab Records
- All Log Records
- All Inventory Transactions
- All Inventory Outward Records
- All Dealers (Users with dealer role)
- All Farmers
- All Employees
- All non-admin Users

**Example request:**
```bash
curl -X DELETE http://localhost:8000/api/v1/clear-data/clear-all \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json"
```

**Example response:**
```json
{
  "success": true,
  "message": "All data deleted successfully",
  "summary": {
    "orders": 150,
    "dealerOrders": 30,
    "slots": 500,
    "dispatches": 80,
    "dealerBookings": 25,
    "dealerWallets": 15,
    "dealers": 10,
    "farmers": 200,
    "employees": 50,
    "sowings": 100,
    "attendance": 5000,
    "labs": 200,
    "logs": 1000,
    "plantOutward": 150,
    "inventoryTransactions": 300,
    "inventoryOutward": 100
  }
}
```

---

### 2. Clear Orders Only
Deletes only orders and related transaction data (keeps users, employees, farmers, slots, etc.)

**Endpoint:** `DELETE /api/v1/clear-data/clear-orders-only`

**Authentication:** Required (JWT token)

**What it deletes:**
- All Dispatches
- All Orders
- All Dealer Orders
- All Dealer Bookings
- All Dealer Wallets

**Example request:**
```bash
curl -X DELETE http://localhost:8000/api/v1/clear-data/clear-orders-only \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json"
```

---

### 3. Clear Slots Only
Deletes only slots data.

**Endpoint:** `DELETE /api/v1/clear-data/clear-slots-only`

**Authentication:** Required (JWT token)

**What it deletes:**
- All Plant Slots

**Example request:**
```bash
curl -X DELETE http://localhost:8000/api/v1/clear-data/clear-slots-only \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json"
```

---

### 4. Clear Dealers Only
Deletes only dealers and their related data (keeps farmers, employees, orders, slots).

**Endpoint:** `DELETE /api/v1/clear-data/clear-dealers-only`

**Authentication:** Required (JWT token)

**What it deletes:**
- All Dealer Orders
- All Dealer Bookings
- All Dealer Wallets
- All Users with "DEALER" role

**Example request:**
```bash
curl -X DELETE http://localhost:8000/api/v1/clear-data/clear-dealers-only \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json"
```

---

## Security Considerations

1. **Backup First**: Always backup your database before running any clear operations
2. **Test Environment**: Test these endpoints in a development environment first
3. **Super Admin Protection**: The clear-all endpoint preserves SUPER_ADMIN users
4. **Irreversible**: Once data is deleted, it cannot be recovered without a backup

## Usage from Frontend/API Client

### Using JavaScript/TypeScript
```javascript
const clearAllData = async () => {
  try {
    const response = await fetch('http://localhost:8000/api/v1/clear-data/clear-all', {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    const result = await response.json();
    console.log(result);
  } catch (error) {
    console.error('Error clearing data:', error);
  }
};
```

### Using Postman
1. Set method to DELETE
2. Enter URL: `http://localhost:8000/api/v1/clear-data/clear-all`
3. Go to "Headers" tab
4. Add header: `Authorization` with value `Bearer YOUR_TOKEN`
5. Click "Send"

## Data Deletion Order

The system deletes data in the following order to avoid foreign key constraint issues:

1. Dispatches (referenced by orders)
2. Orders
3. Dealer Orders
4. Dealer Bookings
5. Dealer Wallets
6. Slots
7. Plant Outward Records
8. Sowing Records
9. Attendance Records
10. Lab Records
11. Log Records
12. Inventory Transactions
13. Inventory Outward Records
14. Dealers
15. Farmers
16. Employees
17. Non-admin Users

## Notes

- All endpoints require authentication
- SUPER_ADMIN users are always preserved
- The system maintains referential integrity by deleting in the correct order
- All operations are logged for audit purposes
- Use with extreme caution in production environments





