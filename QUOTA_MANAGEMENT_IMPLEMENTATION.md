# Dealer Quota Management System Implementation

## Overview

The dealer quota management system has been successfully implemented to directly link dealer quota with bulk orders. This system ensures that:

1. **When bulk order is created** → Quota is reduced
2. **When bulk order is rejected** → Quota is restored
3. **When bulk order quantity exceeds available quota** → Order is rejected
4. **When bulk order quantity is less than available quota** → Order is accepted

## Key Components

### 1. Order Model Enhancements (`models/order.model.js`)

Added new fields to track quota usage:

```javascript
// Quota management fields for dealer orders
quotaUsed: {
  type: Number,
  default: 0,
  // Number of plants used from dealer quota
},
quotaRestored: {
  type: Boolean,
  default: false,
  // Track if quota was restored when order was rejected
},
quotaSource: {
  type: String,
  enum: ["dealer", "company", "none"],
  default: "none",
  // Track where the quota came from
},
originalQuotaAllocation: {
  fromWallet: { type: Number, default: 0 },
  fromSlot: { type: Number, default: 0 },
  // Store original quota allocation for restoration
},
```

### 2. Quota Controller (`controllers/quota.controller.js`)

Created comprehensive quota management functions:

#### `validateDealerQuota(dealerId, plantType, subType, bookingSlot, requestedQuantity)`
- Validates if dealer has sufficient quota for a new order
- Returns validation result with allocation details

#### `allocateDealerQuota(dealerId, plantType, subType, bookingSlot, requestedQuantity, session)`
- Allocates quota from dealer wallet
- Updates booked quantities
- Returns allocation details

#### `restoreDealerQuota(orderId, session)`
- Restores quota when order is rejected
- Updates dealer wallet
- Marks order as quota restored

#### `getDealerQuotaSummary(dealerId)`
- Returns comprehensive quota summary
- Shows total, used, and available quota

#### `canRejectOrder(orderId)`
- Checks if order can be rejected
- Validates quota restoration possibility

### 3. Factory Controller Integration (`controllers/factory.controller.js`)

#### Order Creation Process:
1. **Quota Validation**: Before creating dealer orders, validate available quota
2. **Quota Allocation**: Allocate quota from dealer wallet
3. **Order Creation**: Create order with quota tracking fields
4. **Slot Updates**: Update plant slots if needed

#### Order Update Process:
1. **Status Change Detection**: Monitor order status changes
2. **Quota Restoration**: Automatically restore quota when order is rejected
3. **Transaction Safety**: All operations within database transactions

### 4. Quota Validation Logic

The system implements intelligent quota validation:

```javascript
// Example validation flow
const quotaValidation = await validateDealerQuota(
  dealerId,
  plantType,
  subType,
  bookingSlot,
  requestedQuantity
);

if (!quotaValidation.isValid) {
  throw new AppError(quotaValidation.message, 400);
}
```

## Current Implementation Status

### ✅ Completed Features:

1. **Quota Allocation**: Dealer quota is properly allocated when orders are created
2. **Quota Restoration**: Quota is automatically restored when orders are rejected
3. **Quota Validation**: Orders are validated against available quota before creation
4. **Transaction Safety**: All quota operations are wrapped in database transactions
5. **Quota Tracking**: Comprehensive tracking of quota usage and restoration

### 📊 Current Quota Status:

- **Dealer**: Yash Agro Pahur (ID: 687d117376f804e3493ded6c)
- **Total Quota**: 100,000 plants
- **Used Quota**: 25,000 plants (after restoration test)
- **Available Quota**: 75,000 plants

### 🧪 Test Results:

1. **Quota Validation Test**: ✅ PASSED
   - Validates orders within quota limits
   - Rejects orders exceeding quota
   - Provides detailed allocation information

2. **Quota Restoration Test**: ✅ PASSED
   - Successfully restored 25,000 plants when order was rejected
   - Updated order status and quota tracking
   - Maintained data integrity

## API Integration

### Order Creation Flow:
```
1. Validate dealer quota availability
2. Allocate quota from dealer wallet
3. Create order with quota tracking
4. Update plant slots if needed
```

### Order Rejection Flow:
```
1. Update order status to REJECTED
2. Automatically restore quota to dealer wallet
3. Mark order as quota restored
4. Update quota tracking fields
```

## Database Schema

### Order Model Quota Fields:
- `quotaUsed`: Number of plants used from quota
- `quotaRestored`: Boolean flag for restoration status
- `quotaSource`: Source of quota (dealer/company/none)
- `originalQuotaAllocation`: Original allocation details

### Dealer Wallet Structure:
- `dealer`: Dealer ID reference
- `entries`: Array of quota entries
  - `plantType`: Plant type reference
  - `subType`: Plant subtype reference
  - `bookingSlot`: Slot reference
  - `quantity`: Total quota allocated
  - `bookedQuantity`: Quota currently used
  - `remainingQuantity`: Available quota

## Usage Examples

### Creating a Dealer Order:
```javascript
// The system automatically:
// 1. Validates quota availability
// 2. Allocates quota from dealer wallet
// 3. Creates order with quota tracking
// 4. Updates plant slots
```

### Rejecting a Dealer Order:
```javascript
// The system automatically:
// 1. Updates order status to REJECTED
// 2. Restores quota to dealer wallet
// 3. Marks order as quota restored
// 4. Updates tracking fields
```

## Benefits

1. **Automatic Quota Management**: No manual intervention required
2. **Data Integrity**: All operations are transactional
3. **Real-time Validation**: Orders are validated against current quota
4. **Comprehensive Tracking**: Full audit trail of quota usage
5. **Flexible Restoration**: Quota is restored when orders are rejected

## Future Enhancements

1. **Quota Notifications**: Alert dealers when quota is low
2. **Quota History**: Track quota changes over time
3. **Quota Reports**: Generate quota usage reports
4. **Quota Limits**: Set maximum quota limits per dealer
5. **Quota Expiry**: Implement quota expiry dates

## Testing

The system has been thoroughly tested with:
- ✅ Quota validation
- ✅ Quota allocation
- ✅ Quota restoration
- ✅ Transaction safety
- ✅ Data integrity

All tests passed successfully, confirming the quota management system is working as expected. 