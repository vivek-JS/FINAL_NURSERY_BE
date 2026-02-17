# ✅ Test Results & Debug Log Checklist

## 📊 Test Summary

**Request:** `POST /api/v1/sowing/multiple`
**Status:** ✅ HTTP 201 - Success
**Sowing Created:** 1 record (Papaya - Vikram 77)

**Payload Details:**
- `packetsUsed`: 1
- `packetsToReturn`: 0.54
- `slotId`: 69450c555845df7093733345
- `sowingLocation`: "OFFICE"
- `completeSowing`: true
- `sowedPlant`: 3500

---

## 🔍 Backend Log Checklist

Check your backend terminal/console logs for the following debug messages in order:

### 1. **Initial Extraction** ✅
```
[sowingInProgress] Starting cleanup for slotId=69450c555845df7093733345, sowedPlant=3500, completeSowing=true
[sowingInProgress] Extracted values - packetsUsed: 1, packetsToReturn: 0.54
```

### 2. **Slot Lookup** ✅
```
[sowingInProgress] Looking for slot with ID: 69450c555845df7093733345
[sowingInProgress] ✅ Found slot document for slotId: 69450c555845df7093733345
```

### 3. **Slot Details** ✅
```
[sowingInProgress] 📊 Slot details: { slotId: '...', startDay: ..., sowingInProgressLength: X, ... }
```

### 4. **In-Progress Entry Processing** ✅
```
[sowingInProgress] Checking for in-progress entries. Array length: X
[sowingInProgress] Payload has packetsUsed: 1, packetsToReturn: 0.54
[sowingInProgress] ✅ Found X in-progress entries for slot 69450c555845df7093733345
[sowingInProgress] Entries: [JSON array with progress entries]
```

### 5. **Processing Entry** ✅
```
[sowingInProgress] Processing entry: requestNumber=..., packetsIssued=..., packetsUsed=1, packetsToReturn=0.54
```

### 6. **Return Request Creation** ✅
```
[sowingInProgress] ✅ Creating return request for 0.54 packets
[sowingInProgress] 🔄 createReturnRequestForProgress called with: { ... }
[sowingInProgress] Creating return request for 0.54 packets
[sowingInProgress] ✅ Found SowingRequest: ..., outwardId: ...
[sowingInProgress] ✅ Created return request RR... for 0.54 packets
[sowingInProgress] 📄 Return request details: { requestNumber: '...', quantity: 0.54, ... }
```

### 7. **Mark Packets as Used** ✅
```
[sowingInProgress] ✅ Marking 1 packets as used
[sowingInProgress] 🔄 markPacketsAsUsed called with: { ... }
[sowingInProgress] Marking 1 packets as used
[sowingInProgress] ✅ Found SowingRequest: ..., outwardId: ...
[sowingInProgress] ✅ Found InventoryOutward: ..., items count: X
[sowingInProgress] ✅ Updated usedQuantity from X to Y
[sowingInProgress] 📦 InventoryOutward update details: { ... }
```

### 8. **Slot Trail & Clearing** ✅
```
[sowingInProgress] ✅ Slot officeSowed already updated to: X
[sowingInProgress] ✅ Cleared sowingInProgress array
```

### 9. **Slot Save** ✅
```
[sowingInProgress] ✅ Slot updated successfully
[sowingInProgress] 📊 Final slot state: { slotId: '...', sowingInProgressLength: 0, ... }
```

---

## ✅ Verification Steps

### 1. **Check Return Request Created**
Run this MongoDB query or check via API:
```javascript
db.returnrequests.find({ 
  "referenceType": "SowingInProgress",
  "quantity": 0.54 
}).sort({ createdAt: -1 }).limit(1)
```

**Expected:** A return request with:
- `quantity`: 0.54
- `returnType`: "sowing"
- `status`: "pending"
- `originalQuantity`: [packets issued]
- `usedQuantity`: 1
- `remainingQuantity`: 0.54

### 2. **Check Slot sowingInProgress Cleared**
```javascript
db.plantslots.findOne({ 
  "subtypeSlots.slots._id": ObjectId("69450c555845df7093733345") 
}, {
  "subtypeSlots.slots.$": 1
})
```

**Expected:** The matching slot should have `sowingInProgress: []` (empty array)

### 3. **Check InventoryOutward usedQuantity Updated**
```javascript
// Find the outward entry via SowingRequest
db.sowingrequests.findOne({ 
  _id: ObjectId("[sowingRequestId from progress]") 
})
// Then check the outward item
db.inventoryoutwards.findOne({ 
  _id: ObjectId("[outwardId from above]") 
})
```

**Expected:** The `items[0].usedQuantity` should be incremented by 1

### 4. **Check Slot Trail Entry**
The slot should have a new `slotTrail` entry with:
- `action`: "SOWING_COMPLETED"
- `quantity`: 3500
- All required fields: `previousTotalPlants`, `newTotalPlants`, `previousAvailablePlants`, `newAvailablePlants`

---

## 🐛 Troubleshooting

### If return request NOT created:
- Check logs for: `[sowingInProgress] ⚠️ No SowingRequest found or no outwardId`
- Verify the `sowingInProgress` entry has a valid `sowingRequestId`

### If sowingInProgress NOT cleared:
- Check logs for: `[sowingInProgress] ⚠️ WARNING: No sowingInProgress entries found`
- Verify the slot was found and updated correctly
- Check if slot save was successful: `[sowingInProgress] ✅ Slot updated successfully`

### If packetsUsed NOT updated:
- Check logs for: `[sowingInProgress] ⚠️ No InventoryOutward found or no items`
- Verify the `outwardId` from SowingRequest exists
- Check the final log: `[sowingInProgress] ✅ Updated usedQuantity`

---

## 📝 Notes

- All debug logs are prefixed with `[sowingInProgress]` for easy filtering
- Error logs are prefixed with `[sowingInProgress] ❌` or `⚠️`
- Success logs are prefixed with `[sowingInProgress] ✅`
- Helper function calls are logged with `🔄` prefix

---

## 🎯 Expected Outcome

✅ **Return request created** for 0.54 packets  
✅ **sowingInProgress array cleared** from slot  
✅ **InventoryOutward usedQuantity updated** by 1  
✅ **Slot trail entry added** for SOWING_COMPLETED  
✅ **No errors** in backend logs





