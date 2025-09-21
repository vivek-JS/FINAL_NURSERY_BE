# Role-Based Order Filtering Implementation

## Overview
This implementation adds role-based filtering to the `getOrders` API endpoint to ensure users only see orders relevant to their role and permissions.

## Changes Made

### 1. Modified `getAll` function in `controllers/factory.controller.js`
- Added role-based filtering logic before applying other filters
- Implemented user-specific order filtering based on user role

### 2. Role-Based Access Control

#### SALES Users
- **Access**: Can only see orders where `salesPerson` field matches their user ID
- **Filter Applied**: `{ salesPerson: userId }`

#### DEALER Users  
- **Access**: Can only see orders where `dealer` field matches their user ID
- **Filter Applied**: `{ dealer: userId }`

#### Admin Users (SUPER_ADMIN, ADMIN, OFFICE_ADMIN)
- **Access**: Can see all orders (no filtering applied)
- **Filter Applied**: None (full access)

## API Endpoint
```
GET /api/v1/order/getOrders
```

## Authentication Required
- All requests must include valid JWT token in Authorization header
- Token must be obtained through `/api/v1/user/login` endpoint

## Example Usage

### SALES User Request
```bash
curl -X GET "http://192.168.1.30:8000/api/v1/order/getOrders?limit=10&page=1" \
  -H "Authorization: Bearer <SALES_USER_TOKEN>"
```

### DEALER User Request
```bash
curl -X GET "http://192.168.1.30:8000/api/v1/order/getOrders?limit=10&page=1" \
  -H "Authorization: Bearer <DEALER_USER_TOKEN>"
```

### ADMIN User Request
```bash
curl -X GET "http://192.168.1.30:8000/api/v1/order/getOrders?limit=10&page=1" \
  -H "Authorization: Bearer <ADMIN_USER_TOKEN>"
```

## Implementation Details

### Filtering Logic
```javascript
// Role-based filtering for non-admin users
if (req.user) {
  const userRole = req.user.role;
  const userId = req.user._id;
  
  // Apply role-based filtering
  if (userRole === 'SALES') {
    // SALES users can only see orders assigned to them
    pipeline.push({
      $match: { salesPerson: userId }
    });
  } else if (userRole === 'DEALER') {
    // DEALER users can only see orders assigned to them
    pipeline.push({
      $match: { dealer: userId }
    });
  }
  // SUPER_ADMIN, ADMIN, OFFICE_ADMIN can see all orders (no filtering)
}
```

### Order Model Fields Used
- `salesPerson`: ObjectId reference to User model (for SALES filtering)
- `dealer`: ObjectId reference to User model (for DEALER filtering)

## Testing

### Test Script
Run the test script to verify the implementation:
```bash
node test-role-based-orders.js
```

### Expected Results
1. **SALES users**: Only see orders where `salesPerson` matches their user ID
2. **DEALER users**: Only see orders where `dealer` matches their user ID  
3. **ADMIN users**: See all orders regardless of assignment

## Security Benefits
- **Data Isolation**: Users can only access orders relevant to their role
- **Privacy Protection**: Prevents unauthorized access to order data
- **Compliance**: Ensures proper data access controls are in place

## Backward Compatibility
- Existing API parameters and response format remain unchanged
- Admin users retain full access to all orders
- No breaking changes to existing functionality

## Notes
- The filtering is applied at the database level using MongoDB aggregation pipeline
- Role-based filtering takes precedence over manual `salesPerson` and `dealer` query parameters
- Admin users can still use manual filtering parameters to further narrow down results
