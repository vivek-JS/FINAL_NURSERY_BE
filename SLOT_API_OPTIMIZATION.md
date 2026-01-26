# Slot API Optimization Summary

## Problem
The `/api/v1/slots/getslots` endpoint was taking ~1 minute to respond due to:
1. Missing compound indexes on frequently queried fields
2. N+1 query problem in `populateSlotsWithOrders` function (one query per slot)

## Optimizations Applied

### 1. Database Indexes Added

#### PlantSlot Collection
- **Compound Index**: `{ plantId: 1, year: 1 }`
  - Optimizes the main aggregation query that filters by plantId and year
  - Location: `FINAL_NURSERY_BE/models/slots.model.js`

- **Subtype Index**: `{ "subtypeSlots.subtypeId": 1 }`
  - Optimizes filtering by subtypeId in aggregation pipeline

- **Slot ID Index**: `{ "subtypeSlots.slots._id": 1 }`
  - Optimizes finding slots by their _id

#### Order Collection
- **Compound Index**: `{ bookingSlot: 1, orderStatus: 1 }`
  - Optimizes queries filtering orders by slot and status
  - Location: `FINAL_NURSERY_BE/models/order.model.js`

- **Triple Compound Index**: `{ bookingSlot: 1, orderStatus: 1, quotaSource: 1 }`
  - Optimizes the populateSlotsWithOrders query that filters by all three fields

### 2. Query Optimization

#### Before (N+1 Problem)
```javascript
// Made one query per slot - very slow!
for (const slot of slots) {
  const orders = await Order.find({ bookingSlot: slot._id, ... });
  // Process orders
}
```

#### After (Batch Query)
```javascript
// Collect all slot IDs first
const slotIds = slots.map(s => s._id);

// Single batch query for all slots
const allOrders = await Order.find({
  bookingSlot: { $in: slotIds },
  ...
});

// Map orders back to slots in memory
```

**Performance Improvement**: 
- Before: N queries (where N = number of slots, could be 50+)
- After: 2 queries total (one for orders, one for dealer quota)

### 3. Files Modified

1. **FINAL_NURSERY_BE/models/slots.model.js**
   - Added compound indexes for PlantSlot queries

2. **FINAL_NURSERY_BE/models/order.model.js**
   - Added compound indexes for Order queries

3. **FINAL_NURSERY_BE/controllers/slots.controller.js**
   - Optimized `populateSlotsWithOrders` function to batch queries
   - Reduced from N+1 queries to 2 queries total

4. **FINAL_NURSERY_BE/scripts/add-slot-optimization-indexes.js** (NEW)
   - Migration script to add indexes to existing database

## How to Apply

### Option 1: Automatic (Recommended)
The indexes will be created automatically when the application starts and models are loaded.

### Option 2: Manual Migration
Run the migration script to ensure indexes exist:
```bash
cd FINAL_NURSERY_BE
node scripts/add-slot-optimization-indexes.js
```

## Expected Performance

- **Before**: ~60 seconds for endpoint response
- **After**: < 2 seconds for endpoint response (estimated 30-50x improvement)

## Testing

Test the endpoint:
```bash
curl 'http://localhost:8000/api/v1/slots/getslots?plantId=68fdf6d45832d541b274ad09&subtypeId=694622b695e9e600821f403b&year=2025' \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

## Notes

- Indexes are created in the background (non-blocking)
- Existing queries will automatically use the new indexes
- The optimized `populateSlotsWithOrders` maintains backward compatibility with different bookingSlot formats (ObjectId, array with slotId, array with dates)





