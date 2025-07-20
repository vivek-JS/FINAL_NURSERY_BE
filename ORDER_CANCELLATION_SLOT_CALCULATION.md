# Order Cancellation and Slot Calculation

## Overview

The slot calculation system is **dynamic** and automatically adjusts when orders are cancelled or rejected. When an order status changes to `CANCELLED` or `REJECTED`, the plants are automatically freed up in the slot calculation without affecting the buffer.

## How It Works

### 1. Dynamic Slot Calculation

The system calculates `totalBookedPlants` dynamically from active orders only:

```javascript
// In slotBookedPlantsCalculator.js
const result = await Order.aggregate([
  {
    $match: {
      bookingSlot: slotId,
      orderStatus: { 
        $nin: ['CANCELLED', 'REJECTED'] // Exclude cancelled/rejected orders
      }
    }
  },
  {
    $group: {
      _id: null,
      totalBookedPlants: { $sum: '$numberOfPlants' }
    }
  }
]);
```

### 2. Buffer Handling

- **Buffer is only applied during slot creation and manual buffer adjustments**
- **Buffer is NOT affected when orders are cancelled/rejected**
- Buffer percentage remains constant regardless of order status changes

### 3. Available Plants Calculation

```javascript
// Calculate buffer-adjusted values
const effectiveBuffer = slot.effectiveBuffer || slot.buffer || 0;
const bufferAmount = Math.round((slot.totalPlants * effectiveBuffer) / 100);
const bufferAdjustedCapacity = slot.totalPlants - bufferAmount;
const availablePlants = Math.max(0, bufferAdjustedCapacity - totalBookedPlants);
```

## Key Points

### ✅ What Happens When Order is Cancelled/Rejected

1. **Order status changes** to `CANCELLED` or `REJECTED`
2. **Slot calculation automatically updates** - the cancelled/rejected order is excluded from `totalBookedPlants`
3. **Plants are freed up** - `availablePlants` increases by the number of plants in the cancelled order
4. **Buffer remains unchanged** - buffer percentage and amount stay the same
5. **No manual intervention needed** - everything happens automatically

### ✅ Buffer Behavior

- **Buffer is applied only during:**
  - Slot creation
  - Manual buffer adjustments via API
  - Buffer release operations
- **Buffer is NOT affected by:**
  - Order cancellations
  - Order rejections
  - Order status changes

### ✅ Slot Capacity

- `totalPlants` represents the **actual slot capacity** and remains constant
- `totalBookedPlants` is calculated dynamically from active orders
- `availablePlants` = `bufferAdjustedCapacity` - `totalBookedPlants`

## Implementation Details

### Files Modified

1. **`utility/slotBookedPlantsCalculator.js`**
   - Excludes both `CANCELLED` and `REJECTED` orders from calculations
   - Provides dynamic slot information

2. **`controllers/slots.controller.js`**
   - Updated `populateSlotsWithOrders` to exclude cancelled/rejected orders
   - Updated `calculateTotalBookedPlantsFromOrders` to exclude both statuses

3. **`controllers/factory.controller.js`**
   - No special handling needed - slot calculation is automatic

### Test Script

Run `test-order-cancellation.js` to verify the behavior:

```bash
node test-order-cancellation.js
```

## Example Scenario

**Before Cancellation:**
- Slot capacity: 1000 plants
- Buffer: 10% (100 plants reserved)
- Active orders: 800 plants
- Available plants: 1000 - 100 - 800 = 100 plants

**After Cancelling 200 plants:**
- Slot capacity: 1000 plants (unchanged)
- Buffer: 10% (100 plants reserved) (unchanged)
- Active orders: 600 plants (800 - 200)
- Available plants: 1000 - 100 - 600 = 300 plants ✅

## API Endpoints

The following endpoints automatically reflect the updated calculations:

- `GET /api/v1/slots/plant-names` - Plant summary with slot data
- `GET /api/v1/slots/subtypes-by-plant` - Subtype summary with slot data
- `GET /api/v1/slots/slots-by-plant-subtype` - Detailed slot information
- `GET /api/v1/slots/slot-details/:slotId` - Individual slot details

All these endpoints will show the updated `totalBookedPlants` and `availablePlants` after order cancellation/rejection. 