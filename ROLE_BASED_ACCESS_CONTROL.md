# Role-Based Access Control (RBAC) System

## Overview

The nursery management system now implements a comprehensive role-based access control system with two new user types: **Accountant** and **Office Admin**. This system ensures that payment-related operations are restricted to authorized personnel only.

## User Roles

### 1. Super Admin (SUPER_ADMIN)
- **Level**: 100
- **Permissions**: All permissions (`*`)
- **Description**: Full system access with no restrictions

### 2. Admin (ADMIN)
- **Level**: 90
- **Permissions**: User management, order management, reporting, settings
- **Description**: Administrative access with most system capabilities

### 3. Accountant (ACCOUNTANT) - **NEW**
- **Level**: 80
- **Permissions**: 
  - Order read/write
  - Payment read/write/delete (exclusive)
  - Farmer read
  - Dealer read
  - Report read
- **Description**: Specialized role for financial operations

### 4. Office Admin (OFFICE_ADMIN) - **NEW**
- **Level**: 75
- **Permissions**:
  - Order read/write
  - Farmer read/write
  - Dealer read/write
  - Report read
  - Settings read
- **Description**: Office management role without payment access

### 5. Sales (SALES)
- **Level**: 70
- **Permissions**: Order operations, farmer management, reporting
- **Description**: Sales team access

### 6. Dealer (DEALER)
- **Level**: 50
- **Permissions**: Order operations, basic reporting
- **Description**: Dealer-specific access

### 7. Farmer (FARMER)
- **Level**: 30
- **Permissions**: Order operations, basic reporting
- **Description**: Farmer-specific access

## Payment Access Restrictions

### 🔒 Restricted Operations
The following payment-related operations are **ONLY** available to **Accountants** and **Super Admins**:

1. **Adding Payments**
   - Adding new payments to orders
   - Setting payment amounts and modes
   - Uploading payment receipts

2. **Payment Status Changes**
   - Changing payment status (PENDING → COLLECTED)
   - Rejecting payments
   - Marking payments as pending

3. **Payment Management**
   - Editing payment details
   - Managing payment history
   - Processing wallet transactions

### 🚫 Restricted Routes
The following API endpoints are protected with `requirePaymentAccess` middleware:

```javascript
// Order routes
PATCH /api/v1/order/updatePaymentStatus
PATCH /api/v1/order/payment/:orderId

// Dealer routes  
POST /api/v1/dealer/orders/:orderId/payment
```

## Frontend Implementation

### Role Detection
The frontend uses Redux to store user data and provides utility hooks for role checking:

```javascript
import { useHasPaymentAccess, useIsAccountant, useIsOfficeAdmin } from "utils/roleUtils"

// Check if user has payment access
const hasPaymentAccess = useHasPaymentAccess()

// Check specific roles
const isAccountant = useIsAccountant()
const isOfficeAdmin = useIsOfficeAdmin()
```

### UI Restrictions
Payment-related UI elements are conditionally rendered based on user role:

```javascript
{hasPaymentAccess && (
  <button onClick={handleAddPayment}>
    Add Payment
  </button>
)}
```

## Backend Implementation

### Middleware
New middleware functions for role-based access control:

```javascript
// Payment access middleware
export const requirePaymentAccess = authorizeRoles(['ACCOUNTANT', 'SUPER_ADMIN'])

// Role-specific middleware
export const requireAccountant = authorizeRoles(['ACCOUNTANT', 'SUPER_ADMIN'])
export const requireOfficeAdmin = authorizeRoles(['OFFICE_ADMIN', 'ADMIN', 'SUPER_ADMIN'])
```

### Route Protection
Routes are protected using middleware:

```javascript
router.patch("/updatePaymentStatus", requirePaymentAccess, updatePaymentStatus)
router.patch("/payment/:orderId", requirePaymentAccess, addNewPayment)
```

## Database Schema Updates

### User Model
The user model has been updated to include new roles:

```javascript
role: {
  type: String,
  enum: ["SUPER_ADMIN", "ADMIN", "SALES", "DEALER", "FARMER", "ACCOUNTANT", "OFFICE_ADMIN"],
  default: "FARMER"
},
jobTitle: {
  type: String,
  enum: [
    "Manager", "HR", "SALES", "PRIMARY", "OFFICE_STAFF", 
    "DRIVER", "LABORATORY_MANAGER", "DEALER", "OFFICE_ADMIN", "ACCOUNTANT"
  ]
}
```

## Setup Instructions

### 1. Add Sample Users
Run the user creation script to add sample accountant and office admin users:

```bash
cd FINAL_NURSERY_BE
node add-accountant-office-admin.js
```

### 2. Sample User Credentials

#### Accountants
- **Accountant 1**: Phone: 9876543210, Password: 12345678
- **Accountant 2**: Phone: 9876543211, Password: 12345678

#### Office Admins
- **Office Admin 1**: Phone: 9876543212, Password: 12345678
- **Office Admin 2**: Phone: 9876543213, Password: 12345678

### 3. Testing Role Access

1. **Login as Accountant**: Should see payment buttons and be able to add/change payments
2. **Login as Office Admin**: Should NOT see payment buttons, but can access other features
3. **Login as Super Admin**: Should have full access to all features

## Security Benefits

1. **Payment Security**: Only authorized accountants can modify payment data
2. **Audit Trail**: Clear separation of financial and operational responsibilities
3. **Compliance**: Meets financial management best practices
4. **Data Integrity**: Prevents unauthorized payment modifications

## Error Handling

### 403 Forbidden Response
When users without proper permissions try to access restricted endpoints:

```json
{
  "status": "error",
  "message": "Insufficient permissions",
  "data": null,
  "error": null
}
```

### Frontend Error Handling
The frontend gracefully handles permission errors and shows appropriate messages to users.

## Future Enhancements

1. **Audit Logging**: Track all payment-related actions
2. **Approval Workflows**: Multi-level approval for large payments
3. **Role Hierarchy**: More granular permission levels
4. **Temporary Permissions**: Time-limited access grants

## Support

For questions or issues with the role-based access control system, please refer to:
- Backend logs for authentication errors
- Frontend console for permission-related issues
- Database user collection for role verification 