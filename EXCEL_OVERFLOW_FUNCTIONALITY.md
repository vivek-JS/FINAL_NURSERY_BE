# Excel Import Overflow Functionality

## Overview

The Excel import system now supports overflow bookings, allowing orders to be imported even when slots have insufficient capacity. This is specifically designed for Excel imports where historical data or bulk orders may exceed the originally planned slot capacity.

## How It Works

### Normal Slot Behavior
- Regular order creation checks if `totalPlants >= numberOfPlants`
- If insufficient capacity, the order is rejected with an error

### Excel Import Overflow Behavior
- Excel imports use `updateSlot(bookingSlot, numberOfPlants, "subtract", true)` with `allowOverflow = true`
- No capacity validation when overflow is allowed - orders are always accepted
- `totalPlants` can go negative (overflow state)
- Overflow slots are flagged with `isOverflow: true`

## Key Components

### 1. Enhanced updateSlot Function
```javascript
export const updateSlot = async (bookingSlot, numberOfPlants, action = "subtract", allowOverflow = false)
```
- Added `allowOverflow` parameter to bypass capacity checks
- Allows negative `totalPlants` values when `allowOverflow = true`
- Sets `isOverflow` flag when slot goes negative
- Logs warnings when overflow occurs
- Maintains backward compatibility for regular operations

### 2. Slot Model Updates
- Added `availablePlants` field (computed from `totalPlants`)
- Added `isOverflow` field to track overflow state
- Existing `overflow` field is also updated

### 3. Import Results Enhancement
Excel import results now include:
- `slotInfo`: Current slot status after booking
- `overflowWarning`: Warning message if slot is in overflow
- `summary.overflowSlots`: Count of slots that went into overflow

## API Endpoints

### 1. Get Overflow Slots
```
GET /api/excel/overflow-slots
```
Query parameters:
- `plantId`: Filter by specific plant
- `year`: Filter by year
- `month`: Filter by month

Response includes:
- List of all overflow slots
- Summary statistics
- Overflow amounts per slot

### 2. Reset Overflow Slot
```
POST /api/excel/reset-overflow-slot
```
Body:
```json
{
  "slotId": "slot_id_here",
  "additionalCapacity": 1000
}
```

This increases the slot capacity and removes overflow status if the slot becomes positive.

## Example Usage

### Excel Import with Overflow
```javascript
// When importing Excel file with orders that exceed slot capacity
const results = await importOrdersAndFarmers(fileBuffer);

// Results will include overflow information
console.log(results.summary.overflowSlots); // Number of overflow slots
console.log(results.success[0].overflowWarning); // Warning message if applicable
```

### Checking Overflow Status
```javascript
// Get all overflow slots
const response = await fetch('/api/excel/overflow-slots');
const data = await response.json();

console.log(data.data.totalOverflowSlots); // Total overflow slots
console.log(data.data.summary.totalOverflowPlants); // Total overflow plants
```

### Resetting Overflow Slot
```javascript
// Add capacity to bring slot out of overflow
const response = await fetch('/api/excel/reset-overflow-slot', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    slotId: 'slot_id_here',
    additionalCapacity: 1000
  })
});
```

## Benefits

1. **Historical Data Import**: Allows importing historical orders that may exceed current capacity
2. **Bulk Order Processing**: Handles large Excel files with orders that exceed slot limits
3. **Flexible Capacity Management**: Provides tools to manage and reset overflow situations
4. **Transparency**: Clear reporting of overflow status and amounts
5. **Data Integrity**: Maintains transaction safety while allowing overflow
6. **Backward Compatibility**: Regular operations continue to work as before

## Monitoring and Management

### Overflow Indicators
- `isOverflow` flag in slot data
- Negative `totalPlants` values
- Warning messages in import results
- Dedicated overflow reporting endpoint

### Best Practices
1. Monitor overflow slots regularly
2. Use the overflow slots endpoint to identify problematic slots
3. Reset overflow slots by adding capacity when possible
4. Consider adjusting slot capacity planning based on overflow patterns

## Testing

Use the test file `test-overflow.js` to verify overflow functionality:
```bash
node test-overflow.js
```

This will test:
- Booking more plants than available (overflow)
- Adding capacity to bring slot out of overflow
- Proper flag management

## Migration Notes

- Existing slots are not affected
- Only Excel imports use overflow functionality (when `allowOverflow = true`)
- Regular order creation still enforces capacity limits
- Overflow slots can be identified and managed through new endpoints
- The `updateSlot` function now accepts an optional `allowOverflow` parameter 