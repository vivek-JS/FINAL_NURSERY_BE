# Order For - Automatic Farmer Creation

## Overview
Implemented automatic farmer creation when an order includes `orderFor` data with name and mobile number.

## What Was Changed

### 1. **Modified Order Creation Logic** (`controllers/factory.controller.js`)

Added logic after order creation (within the transaction) to:
- Check if `orderFor` field has both `name` and `mobileNumber`
- If yes, create a new farmer record automatically
- Prevent duplicates by checking if farmer with that mobile number already exists

### 2. **Implementation Details**

**Location:** Lines 562-602 in `factory.controller.js`

**Logic Flow:**
```
1. Check if req.body.orderFor exists AND has name and mobileNumber
2. Search for existing farmer with that mobileNumber
3. If NOT found:
   - Create new farmer with orderFor data
   - Use address for village field (or "To be updated")
   - Set other required fields to "To be updated"
4. If found:
   - Log that farmer already exists (no duplicate created)
5. Transaction continues (doesn't fail if farmer creation fails)
```

**Fields Used for Farmer Creation:**
```javascript
{
  name: orderFor.name,
  mobileNumber: orderFor.mobileNumber,
  village: orderFor.address || "To be updated",
  taluka: "To be updated",
  district: "To be updated",
  state: "To be updated",
  stateName: "To be updated",
  talukaName: "To be updated",
  districtName: "To be updated"
}
```

### 3. **Key Features**

✅ **Automatic Creation**: No manual step needed - farmer is created when order is placed
✅ **Duplicate Prevention**: Checks mobile number to avoid creating duplicate farmers
✅ **Transaction Safe**: Uses session to ensure atomicity
✅ **Error Resilient**: Order creation doesn't fail if farmer creation fails
✅ **Console Logging**: Logs farmer creation for debugging

## How It Works

### Example Scenario:

1. **User creates order with orderFor data:**
```json
{
  "name": "Main Farmer",
  "mobileNumber": 9876543210,
  // ... other farmer fields
  
  "orderFor": {
    "name": "John Doe",
    "address": "123 Main St, Mumbai",
    "mobileNumber": 9123456789
  },
  
  // ... order details
}
```

2. **System automatically:**
   - Creates the order
   - Checks if farmer exists with mobile 9123456789
   - If not, creates new farmer "John Doe"
   - Completes the transaction

3. **Result:**
   - ✅ Order created
   - ✅ New farmer "John Doe" created
   - ✅ Can be found by searching mobile 9123456789

## Testing

### Manual Test
1. Create an order with `orderFor` data
2. Check farmer list or search by mobile number
3. Verify farmer was created

### Automated Test
Run the provided test script:
```bash
node test-orderfor-farmer-creation.js
```

**Before running:**
- Update `authToken` with valid JWT
- Update IDs (salesPerson, plantName, plantSubtype, bookingSlot)

### Test Cases Covered:
1. ✅ Order with orderFor creates new farmer
2. ✅ Duplicate mobile number doesn't create duplicate farmer
3. ✅ Farmer can be retrieved by mobile number
4. ✅ Address is stored in village field

## Database Schema

### Order Model (`orderFor` field):
```javascript
orderFor: {
  name: { type: String },
  address: { type: String },
  mobileNumber: { type: Number }
}
```

### Farmer Model (created fields):
```javascript
{
  name: String (required),
  mobileNumber: Number (optional but indexed),
  village: String (required) - stores address from orderFor
  // ... other required fields set to "To be updated"
}
```

## API Endpoints

### Create Order (which creates farmer)
```
POST /api/v1/farmer/createFarmer
```

**Request Body:**
```json
{
  "name": "Main Farmer Name",
  "mobileNumber": 9876543210,
  "village": "Village Name",
  // ... all required farmer fields
  
  "orderFor": {
    "name": "Secondary Person Name",
    "address": "Full Address",
    "mobileNumber": 9123456789
  },
  
  // ... order fields
  "numberOfPlants": 100,
  "rate": 25,
  "salesPerson": "...",
  "plantName": "...",
  "plantSubtype": "...",
  "bookingSlot": "..."
}
```

### Find Created Farmer
```
GET /api/v1/farmer/find/:mobileNumber
```

Example: `GET /api/v1/farmer/find/9123456789`

## Console Logs

When a farmer is created from orderFor, you'll see:
```
Creating farmer from orderFor data: { name: 'John Doe', address: '...', mobileNumber: 9123456789 }
Created new farmer from orderFor: <farmer_id>
```

When farmer already exists:
```
Farmer already exists with mobile number: 9123456789
```

## Error Handling

- If farmer creation fails, error is logged but order creation continues
- Wrapped in try-catch to prevent order creation failure
- Uses database session for transaction consistency

## Future Enhancements (Optional)

1. **Address Parsing**: Parse address string to extract state, district, taluka
2. **Smart Matching**: Check if farmer exists by name + partial mobile
3. **Update Existing**: Option to update existing farmer's address
4. **Validation**: Validate mobile number format before creation
5. **Notification**: Send SMS/notification to newly created farmer

## Notes

- Farmer records created this way will have "To be updated" in location fields
- These can be updated later by admin or the farmer
- Mobile number uniqueness is maintained by the database
- Address is stored in the `village` field for now

## Related Files

- `controllers/factory.controller.js` - Main implementation
- `models/order.model.js` - Order schema with orderFor field
- `models/farmer.model.js` - Farmer schema
- `test-orderfor-farmer-creation.js` - Test script

