# Generate 100 Orders Script

This script generates 100 orders with variations in:
- Plant quantities (1000 to 45000)
- Various plant subtypes
- Different dates (December 2025, January 2026, February 2026, March 2026)
- Various farmers from the database

## Prerequisites

1. **MongoDB Connection**: Ensure MongoDB is running and accessible
2. **Database Setup**: The database should have:
   - At least 1 farmer in the `Farmer` collection
   - At least 1 plant with subtypes in the `PlantCms` collection
   - At least 1 sales person/user with role `SALES_PERSON`, `DEALER`, or `OFFICE_ADMIN`
   - At least 1 booking slot in the `PlantSlot` collection
   - At least 1 cavity/tray in the `Tray` collection (optional but recommended)

3. **Environment Variables**: Create a `.env` file in `FINAL_NURSERY_BE` directory:
```env
MONGODB_URI=mongodb://localhost:27017/nursery
API_BASE_URL=http://localhost:8000
AUTH_TOKEN=your_jwt_token_here
```

## How to Run

### Option 1: Using Node.js directly

```bash
cd FINAL_NURSERY_BE
node scripts/generate-100-orders.js
```

### Option 2: Using npm script (if added to package.json)

```bash
cd FINAL_NURSERY_BE
npm run generate-orders
```

## What the Script Does

1. **Connects to MongoDB** and fetches:
   - Up to 200 farmers (with mobile numbers)
   - All plants and their subtypes
   - Sales persons (users with appropriate roles)
   - Booking slots
   - Cavities/trays

2. **Generates 100 orders** with:
   - Random farmer selection from database
   - Random plant and subtype
   - Random plant quantity between 1000-45000
   - Random rate (1.5-3.5, varies by plant type)
   - Random dates from Dec 2025, Jan 2026, Feb 2026, or March 2026
   - Random payment status (not paid, partially paid, paid)
   - Random order status (ACCEPTED, PENDING, PROCESSING)

3. **Makes API calls** to `/api/v1/farmer/createFarmer` endpoint

4. **Reports results** showing:
   - Success count
   - Error count
   - Total attempts

## Order Data Structure

Each order includes:
```json
{
  "name": "Farmer Name",
  "village": "Village Name",
  "taluka": "Taluka ID",
  "state": "State",
  "district": "District ID",
  "stateName": "State Name",
  "districtName": "District Name",
  "talukaName": "Taluka Name",
  "mobileNumber": "9823832132",
  "numberOfPlants": "5000",
  "rate": "2.1",
  "paymentStatus": "not paid",
  "salesPerson": "sales_person_id",
  "orderStatus": "ACCEPTED",
  "plantName": "plant_id",
  "plantSubtype": "subtype_id",
  "bookingSlot": "slot_id",
  "cavity": "cavity_id",
  "orderDate": "2025-12-15T18:30:00.000Z",
  "deliveryDate": "2025-12-15T18:30:00.000Z",
  "orderPaymentStatus": "PENDING",
  "orderBookingDate": "2025-12-15T16:30:37.280Z"
}
```

## Customization

You can modify the script to:
- Change the number of orders (currently 100)
- Adjust plant quantity range (currently 1000-45000)
- Modify rate ranges for different plant types
- Add more date ranges
- Change payment/order status options

## Troubleshooting

### Error: "No farmers found"
- Ensure you have farmers in the database with valid mobile numbers
- Check MongoDB connection

### Error: "No plants found"
- Ensure you have plants in the `PlantCms` collection
- Ensure plants have subtypes defined

### Error: "No sales persons found"
- Ensure you have users with roles: `SALES_PERSON`, `DEALER`, or `OFFICE_ADMIN`

### Error: "No booking slots found"
- Ensure you have slots in the `PlantSlot` collection

### API Errors
- Check if the API server is running
- Verify the AUTH_TOKEN is valid and not expired
- Check API endpoint URL is correct

## Output Example

```
✅ Connected to MongoDB
📊 Fetching data from database...
✅ Found 150 farmers
✅ Found 25 plants
✅ Found 45 plant subtypes
✅ Found 10 sales persons
✅ Found 30 booking slots
✅ Found 15 cavities/trays

🚀 Generating 100 orders...

✅ Order 1/100 created - Kiran chaudhari - 5000 Tomato Hybrid - December 2025
✅ Order 2/100 created - Rajesh Kumar - 12000 Chilli Red - January 2026
...
✅ Order 100/100 created - Suresh Patel - 8500 Brinjal Purple - March 2026

📊 Summary:
✅ Successfully created: 98 orders
❌ Failed: 2 orders
📈 Total: 100 orders attempted

✅ Disconnected from MongoDB
```

## Notes

- The script includes a 100ms delay between requests to avoid overwhelming the server
- Orders are created with realistic data variations
- If a farmer doesn't have complete location data, default values are used
- The script handles errors gracefully and continues with the next order

