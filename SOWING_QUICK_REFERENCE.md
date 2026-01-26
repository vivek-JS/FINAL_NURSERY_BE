# Sowing System - Quick Reference Guide

## 🚀 Quick Start

### For Users (5-Minute Guide)

#### Creating a Stock Request
1. Open **Sowing Gap Analysis** page
2. Find card showing gap > 0
3. Click **"Request Stock"** button
4. Confirm packets needed
5. Done! Request sent to inventory

#### Creating Excessive Sowing
1. Click **"Create Excessive Sowing"** (green button)
2. Select plant → subtype
3. Enter packets
4. Pick date
5. Create request

#### Primary Sowing Entry
1. Open **Primary Sowing Entry** (mobile)
2. Click any card to auto-fill
3. Adjust quantities if needed
4. Click **"Review"** → **"Confirm & Save"**
5. Share on WhatsApp if needed

---

### For Developers (5-Minute Guide)

#### Key Files to Know
```
Backend:
- models/slots.model.js          # THE MOST IMPORTANT
- models/sowingRequest.model.js  # Request lifecycle
- controllers/excessiveSowing.controller.js
- helpers/slotTransactionLogger.js

Frontend:
- pages/SowingGapAnalysis.js
- components/ExcessiveSowingModal.jsx
- pages/PrimarySowingEntry.jsx
```

#### Creating a New Sowing Feature

**Step 1: Update Model** (if needed)
```javascript
// models/slots.model.js
// Add new field in slot schema
myNewField: {
  type: String,
  default: ''
}
```

**Step 2: Create Controller**
```javascript
// controllers/myFeature.controller.js
export const myNewFeature = async (req, res) => {
  try {
    // 1. Get slot
    const slot = await PlantSlot.findOne({...});
    
    // 2. Update slot
    slot.myNewField = req.body.value;
    
    // 3. Log transaction
    logCustomAction(slot, userId, details);
    
    // 4. Save
    await slot.save();
    
    return res.json({ success: true });
  } catch (error) {
    return handleError(res, error);
  }
};
```

**Step 3: Add Route**
```javascript
// routes/sowing.route.js
import { myNewFeature } from '../controllers/myFeature.controller.js';
router.post('/my-feature', myNewFeature);
```

**Step 4: Add API Endpoint**
```javascript
// Frontend: network/config/endpoints.js
MY_NEW_FEATURE: new APIRouter("/sowing/my-feature", HTTP_METHODS.POST)
```

**Step 5: Use in Component**
```javascript
// Frontend component
const instance = NetworkManager(API.sowing.MY_NEW_FEATURE);
const response = await instance.request({ value: 'test' });
```

---

## 📊 Key Concepts (1-Minute Read)

### Slot = Time Window for Sowing
- Has start/end date
- Contains orders
- Tracks sowing progress
- Maintains transaction history

### Request = Stock Request for Sowing
- Created when gap exists
- Goes through: pending → issued → completed
- Tracks progress: sowedQuantity, remainingSowing

### Gap = Orders - Sowed
- **Positive gap**: Need to sow more
- **Negative gap**: Sowed more than orders (available)
- **Buffer**: Extra % added to gap for safety

### Excessive Sowing = Sowing without orders
- For future stock
- Creates its own slot
- Marked with `isExcessiveSowing = true`

---

## 🎯 Common Tasks

### Get Gap for a Plant/Subtype
```javascript
const pipeline = [
  { $match: { plantId: mongoose.Types.ObjectId(plantId) }},
  { $unwind: '$subtypeSlots' },
  { $match: { 'subtypeSlots.subtypeId': mongoose.Types.ObjectId(subtypeId) }},
  { $unwind: '$subtypeSlots.slots' },
  // Calculate gap for each slot
  { $addFields: {
    'subtypeSlots.slots.bookingGap': {
      $subtract: [
        '$subtypeSlots.slots.totalBookedPlants',
        { $add: ['$subtypeSlots.slots.officeSowed', '$subtypeSlots.slots.primarySowed'] }
      ]
    }
  }}
];
```

### Create Request & Update Slot
```javascript
// 1. Create request
const request = await SowingRequest.create({...});

// 2. Find slot
const slot = await findSlot(slotId);

// 3. Link request to slot
slot.linkedSowingRequests.push(request._id);

// 4. Log transaction
logSowingRequestCreated(slot, request._id, quantity, userId);

// 5. Save slot
await slot.save();
```

### Update Progress
```javascript
// 1. Get request
const request = await SowingRequest.findById(requestId);

// 2. Update quantity
request.sowedQuantity += sowedQty;

// 3. Calculate remaining
const expected = request.packetsRequested * request.conversionFactor;
request.remainingSowingNeeded = Math.max(0, expected - request.sowedQuantity);

// 4. Check completion
if (request.remainingSowingNeeded <= 0) {
  request.sowingCompleted = true;
}

// 5. Save
await request.save();
```

### Log Transaction
```javascript
import { logSowingStarted } from '../helpers/slotTransactionLogger.js';

const slot = await findSlot(slotId);

logSowingStarted(slot, quantity, userId, {
  sowingDate: '25-12-2024',
  location: 'OFFICE',
  notes: 'Started sowing'
});

await slot.save(); // Trail auto-saved
```

---

## 🔥 Pro Tips

### Backend
1. **Always log transactions** - Future you will thank you
2. **Use aggregation for reports** - 10x faster than loops
3. **Index frequently queried fields** - Status, dates, IDs
4. **Validate conversion factors** - Avoid division by zero
5. **Handle decimals carefully** - Use `Number.toFixed(2)`

### Frontend
1. **Debounce API calls** - Don't hammer the server
2. **Show loading states** - Users love feedback
3. **Cache responses** - Reduce API calls
4. **Validate before submit** - Better UX
5. **Use optimistic updates** - Update UI immediately

### Testing
1. **Test with zero quantities** - Edge case
2. **Test with decimals** - 0.5 packets
3. **Test request lifecycle** - All statuses
4. **Test concurrent updates** - Race conditions
5. **Test error scenarios** - Network failures

---

## 🐛 Debug Checklist

### Request Not Creating?
- [ ] Conversion factor set in product?
- [ ] Primary/secondary unit configured?
- [ ] User has permission?
- [ ] Product is active?
- [ ] Plant sowing allowed?

### Gap Not Showing?
- [ ] Orders exist for slot?
- [ ] Slot date is today/overdue?
- [ ] totalBookedPlants > sowed?
- [ ] Buffer configured correctly?
- [ ] Slot is active?

### Progress Not Updating?
- [ ] Request status is "issued"?
- [ ] Correct requestId passed?
- [ ] sowedQuantity is number?
- [ ] Slot linked to request?
- [ ] Conversion factor correct?

### Stock Not Issuing?
- [ ] Packets available in inventory?
- [ ] Batch number matches?
- [ ] Product is active?
- [ ] Outward created successfully?
- [ ] User has inventory permission?

---

## 📞 Quick Help

### Error Codes
- `400` - Validation failed
- `404` - Resource not found
- `500` - Server error

### Logs Location
```bash
# Backend logs
tail -f logs/sowing.log

# Database queries
db.setProfilingLevel(2)
db.system.profile.find().limit(5).sort({ts:-1})
```

### Common Fixes
```bash
# Recalculate all gaps
node scripts/recalculateGaps.js

# Reset request statuses
node scripts/resetRequests.js

# Fix orphaned slots
node scripts/fixOrphanedSlots.js
```

---

## 🎨 UI Component Hierarchy

```
SowingGapAnalysis (Main Page)
├── Header (Analytics, Refresh buttons)
├── Today's Sowing Cards Section
│   ├── Summary Cards (Due, Today, Total)
│   ├── Subtype Cards Grid
│   │   ├── Card (per plant/subtype)
│   │   │   ├── Plant/Subtype info
│   │   │   ├── Quantities display
│   │   │   ├── Request/Cancel buttons
│   │   │   └── Stock status chip
│   └── Request All button
├── Tabs (Critical / Available)
├── Stats Cards (Total Plants, Subtypes, Gap)
├── Analytics Charts
│   ├── Top Subtypes Bar Chart
│   ├── Gap Distribution Pie Chart
│   ├── Priority Distribution Chart
│   └── Plant-wise Subtype Count
└── Plants Accordion
    ├── Plant Card (expandable)
    │   ├── Plant header & stats
    │   └── Subtypes List
    │       ├── Subtype Card (expandable)
    │       │   ├── Subtype header & stats
    │       │   └── Reminders Table
    │       │       ├── Slot rows
    │       │       └── View Orders button
    └── Modals
        ├── ExcessiveSowingModal
        ├── SlotOrdersDialog
        ├── AlertDialog
        ├── ConfirmDialog
        └── PromptDialog
```

---

## 🚦 Request Status Flow (Visual)

```
[Create Request]
      ↓
  ⚪ PENDING ----[Cancel]---→ ⚫ CANCELLED
      ↓
      [Manager Reviews]
      ↓
  🟠 PROCESSING --[Reject]--→ 🔴 REJECTED
      ↓
      [Issue Stock]
      ↓
  🟢 ISSUED
      ↓
      [Start Sowing]
      ↓
  🔵 IN_PROGRESS (sowingInProgress = true)
      ↓
      [Complete Sowing]
      ↓
  ✅ COMPLETED (sowingCompleted = true)
```

---

## 💡 Formula Reference

### Gap Calculation
```
totalBooked = Σ(orders.numberOfPlants) for slot
totalSowed = officeSowed + primarySowed
rawGap = totalBooked - totalSowed
bufferAmount = (rawGap × bufferPercentage) / 100
bookingGap = rawGap + bufferAmount
```

### Progress Percentage
```
expectedPlants = packetsRequested × conversionFactor
sowedQuantity = Σ(sowing.sowedPlant) for request
progressPercentage = (sowedQuantity / expectedPlants) × 100
remainingSowing = expectedPlants - sowedQuantity
```

### Priority Calculation
```
daysUntilSow = sowByDate - today
if daysUntilSow < 0 → OVERDUE (red)
if daysUntilSow ≤ 2 → URGENT (orange)
if daysUntilSow ≤ 5 → UPCOMING (blue)
if daysUntilSow > 5 → FUTURE (gray)
```

### Plant Ready Date
```
plantReadyDate = sowingDate + plantReadyDays
reminderDate = plantReadyDate - reminderBeforeDays
```

---

## 🎯 Performance Metrics

### Target Response Times
- Get Today's Cards: < 500ms
- Create Request: < 200ms
- Update Progress: < 150ms
- Gap Summary: < 1s

### Optimization Tips
```javascript
// ❌ Bad: Loop through documents
for (const slot of slots) {
  const orders = await Order.find({ 'items.slotId': slot._id });
  // Process...
}

// ✅ Good: Use aggregation
const results = await PlantSlot.aggregate([
  { $lookup: { from: 'orders', ... }},
  { $group: { ... }}
]);
```

---

## 📝 Code Snippets

### Get Request with Full Details
```javascript
const request = await SowingRequest.findById(requestId)
  .populate('requestedBy', 'name email')
  .populate('issuedBy', 'name email')
  .populate('plantId', 'plantName')
  .populate('productId', 'productName')
  .populate('outwardId')
  .lean();
```

### Find Slot by Date
```javascript
const slot = await PlantSlot.findOne({
  plantId,
  year: moment(date, 'DD-MM-YYYY').year(),
  'subtypeSlots.subtypeId': subtypeId,
  'subtypeSlots.slots': {
    $elemMatch: {
      startDay: date,
      endDay: date
    }
  }
});
```

### Calculate All Gaps (Efficient)
```javascript
const gaps = await PlantSlot.aggregate([
  { $match: { year: 2024 }},
  { $unwind: '$subtypeSlots' },
  { $unwind: '$subtypeSlots.slots' },
  { $lookup: {
      from: 'orders',
      let: { slotId: '$subtypeSlots.slots._id' },
      pipeline: [
        { $unwind: '$items' },
        { $match: { $expr: { $eq: ['$items.slotId', '$$slotId'] }}},
        { $group: { _id: null, total: { $sum: '$items.numberOfPlants' }}}
      ],
      as: 'orderData'
  }},
  { $addFields: {
    totalBooked: { $arrayElemAt: ['$orderData.total', 0] },
    totalSowed: {
      $add: [
        '$subtypeSlots.slots.officeSowed',
        '$subtypeSlots.slots.primarySowed'
      ]
    }
  }},
  { $addFields: {
    gap: { $subtract: ['$totalBooked', '$totalSowed'] }
  }},
  { $match: { gap: { $gt: 0 }}}
]);
```

---

**Last Updated: December 18, 2024**
**Version: 1.0.0**






