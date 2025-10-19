# Order For API Implementation

## Overview
Updated the order retrieval APIs to include the `orderFor` field when present in orders. This ensures that when orders are fetched, the "Order For" information is properly returned to the frontend applications.

## Changes Made

### 1. Factory Controller (`factory.controller.js`)

**File**: `/Users/VivekP/Movies/ram/FINAL_NURSERY_BE/controllers/factory.controller.js`

**Function**: `getAll()` - Used for general order retrieval via `/order/getOrders`

**Changes**:
- Added `orderFor: 1` to the `$project` stage in the aggregation pipeline
- This ensures that when orders are fetched, the `orderFor` field is included in the response

**Location**: Line ~2026 in the projection stage

```javascript
// Add orderFor field if present
orderFor: 1,
```

### 2. Order Controller (`order.controller.js`)

**File**: `/Users/VivekP/Movies/ram/FINAL_NURSERY_BE/controllers/order.controller.js`

#### A. `getOrdersBySlot()` Function

**Changes**:
- Added `orderFor: order?.orderFor` to the order mapping
- This ensures that when orders are fetched by slot, the `orderFor` information is included

**Location**: Line ~100 in the order mapping

```javascript
orderFor: order?.orderFor, // Add orderFor field
```

#### B. `getOrdersByStatus()` Function

**Changes**:
- Added `orderFor: 1` to the `$project` stage in the aggregation pipeline
- This ensures that when orders are fetched by status, the `orderFor` field is included

**Location**: Line ~1188 in the projection stage

```javascript
// Add orderFor field if present
orderFor: 1,
```

#### C. `getCsv()` Function

**Changes**:
- Added three new columns to the CSV export:
  - "Order For Name"
  - "Order For Mobile" 
  - "Order For Address"
- Updated the `baseOrderData` object to include orderFor information

**Location**: Lines ~186-188 and ~243-245

```javascript
// CSV Fields
"Order For Name",
"Order For Mobile", 
"Order For Address"

// Base Order Data
"Order For Name": obj.orderFor?.name || 'N/A',
"Order For Mobile": obj.orderFor?.mobileNumber || 'N/A',
"Order For Address": obj.orderFor?.address || 'N/A'
```

## API Endpoints Affected

The following API endpoints now include the `orderFor` field in their responses:

1. **`GET /order/getOrders`** - Main order retrieval endpoint
2. **`GET /order/getOrdersBySlot/:slotId`** - Orders by slot
3. **`GET /order/getOrdersByStatus`** - Orders by status
4. **`GET /order/getCsv`** - CSV export (includes Order For columns)

## Response Structure

When an order contains `orderFor` data, the API response will include:

```json
{
  "data": {
    "orderFor": {
      "name": "John Doe",
      "address": "123 Main Street, Test City",
      "mobileNumber": 9876543210
    },
    // ... other order fields
  }
}
```

When an order does not have `orderFor` data, the field will be `null` or `undefined`.

## CSV Export

The CSV export now includes three additional columns:
- **Order For Name**: The name of the person the order is for
- **Order For Mobile**: The mobile number of the person the order is for  
- **Order For Address**: The address of the person the order is for

If no Order For data exists, these columns will show "N/A".

## Backward Compatibility

- All changes are backward compatible
- Existing orders without `orderFor` data will continue to work normally
- The `orderFor` field will simply be `null` or `undefined` for orders without this data
- Frontend applications can safely check for the presence of `orderFor` data before displaying it

## Testing

To test the implementation:

1. **Create an order with Order For data** using the Android app or web application
2. **Fetch orders** using any of the affected endpoints
3. **Verify** that the `orderFor` field is present in the response
4. **Export CSV** and verify that Order For columns are included

## Integration Status

✅ **Backend Models**: Order model includes `orderFor` field  
✅ **Backend Creation**: Order creation includes `orderFor` data  
✅ **Backend Retrieval**: All order retrieval APIs include `orderFor` field  
✅ **Android App**: Order For functionality implemented  
✅ **Web Application**: Order For functionality implemented  
✅ **CSV Export**: Order For data included in exports  

The Order For feature is now fully implemented across the entire system!
