# Generate 100 Orders - Implementation Summary

## Overview
Created a script to generate 100 orders with variations in plant quantities, subtypes, dates, and farmers.

## Files Created

### 1. `scripts/generate-100-orders.js`
Main script that:
- Connects to MongoDB
- Fetches farmers, plants, subtypes, sales persons, slots, and cavities
- Generates 100 orders with random variations
- Makes API calls to create orders

### 2. `scripts/GENERATE_ORDERS_README.md`
Complete documentation with:
- Prerequisites
- How to run instructions
- Customization options
- Troubleshooting guide

## Order Variations

### Plant Quantities
- Range: **1000 to 45000** (randomly selected)

### Dates
- **December 2025**
- **January 2026**
- **February 2026**
- **March 2026**
- Random dates within each month

### Plants & Subtypes
- Randomly selects from all available plants and subtypes in database
- Ensures valid plant-subtype combinations

### Farmers
- Randomly selects from existing farmers in database
- Uses farmer's actual data (name, village, taluka, district, state, mobile)

### Other Variations
- **Rates**: 1.5-3.5 (varies by plant type)
  - Tomato: 2.0-3.0
  - Chilli: 1.8-2.8
  - Brinjal: 2.2-3.2
  - Others: 1.5-3.5
- **Payment Status**: not paid, partially paid, paid
- **Order Status**: ACCEPTED, PENDING, PROCESSING

## Quick Start

1. **Set up environment variables** (optional - defaults provided):
```bash
# In FINAL_NURSERY_BE/.env
MONGODB_URI=mongodb://localhost:27017/nursery
API_BASE_URL=http://localhost:8000
AUTH_TOKEN=your_token_here
```

2. **Run the script**:
```bash
cd FINAL_NURSERY_BE
node scripts/generate-100-orders.js
```

## Requirements

The script requires:
- ✅ MongoDB connection
- ✅ At least 1 farmer in database
- ✅ At least 1 plant with subtypes
- ✅ At least 1 sales person (SALES_PERSON, DEALER, or OFFICE_ADMIN role)
- ✅ At least 1 booking slot
- ✅ At least 1 cavity/tray (optional but recommended)
- ✅ API server running on specified URL
- ✅ Valid authentication token

## Output

The script will:
1. Show data fetching progress
2. Display each order creation status
3. Provide final summary:
   - Success count
   - Error count
   - Total attempts

## Example Output

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
```

## Notes

- Script includes 100ms delay between requests
- Handles errors gracefully
- Uses actual farmer data from database
- Ensures delivery date is after order date
- Validates all required data before starting

