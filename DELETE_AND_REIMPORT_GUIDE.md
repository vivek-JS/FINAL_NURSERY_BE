# Delete All Orders and Reimport Guide

This guide explains how to delete all orders, reset slots, and reimport orders from Excel files.

## Quick Start

### 1. Delete All Orders and Reset Slots

Run the cleanup script:

```bash
cd FINAL_NURSERY_BE
node delete-all-orders-and-reset.js
```

This script will:
- ✅ Delete all Orders
- ✅ Delete all Dealer Orders  
- ✅ Delete all Dispatch Records
- ✅ Delete all Dealer Bookings
- ✅ Delete all Dealer Wallet Transactions
- ✅ Reset all Slot bookings (totalBookedPlants = 0)
- ✅ Clear slot orders arrays
- ✅ Reset slot overflow flags
- ✅ Prepare database for fresh import

**⚠️ WARNING**: This action is **IRREVERSIBLE**. All order-related data will be permanently deleted.

The script will:
1. Show counts of existing data
2. Wait 3 seconds (press Ctrl+C to cancel)
3. Delete all order-related data
4. Reset all slots
5. Verify the cleanup
6. Display a summary

### 2. Reimport Orders

After deletion, import orders from Excel file:

```bash
# Main import script (most comprehensive)
node import-all-booking.js

# Or use specific import scripts:
node import-first-order.js
node import-second-order.js
node import-dec3-order.js
node import-dec4-order.js
```

## Import Script Details

### `import-all-booking.js`
- Main import script for importing orders from Excel
- Supports multiple date formats
- Handles slot matching with date offsets
- Generates error reports for failed imports
- Saves failed imports to `import-failures.json` and `import-failures.xlsx`

### Excel File Format Required

Your Excel file should contain these columns:
- Date
- Booking NO.
- Name
- Mobile No.
- Address
- Taluka
- District
- Advance On Booking Receipts
- adv match or not
- Advance Amt.
- Crop (Plant Name)
- Variety (Plant Subtype)
- Media
- Expected Nursery
- Plant Qty.
- Rate
- Expected Del. Date
- Old Del. Date
- Del. Y/N
- Actually Del. Date
- Invoice amount
- Bal. Amt.
- Refrence
- Order By
- Ad. Amt. Mode
- Bank
- CH No.
- Advance Date
- ADV Y/N
- CC Y/N
- Remark

## What Gets Deleted

The cleanup script deletes:
1. **Orders** - All order records
2. **DealerOrders** - All dealer order records
3. **Dispatch** - All dispatch records
4. **DealerBooking** - All dealer booking records
5. **DealerWallet** - All dealer wallet transactions

## What Gets Reset

The cleanup script resets:
1. **Slot Bookings** - `totalBookedPlants` set to 0
2. **Slot Orders Array** - Cleared
3. **Slot Overflow Flags** - Reset to false
4. **Slot Status** - Reset to available (false)

## What is Preserved

The following data is **NOT** deleted:
- ✅ Users (Farmers, Dealers, Employees)
- ✅ Plant CMS (Plants and Subtypes)
- ✅ Location Data (States, Districts, Villages)
- ✅ Slot Structures (slot dates, capacities)
- ✅ System Configuration

## Step-by-Step Process

### Complete Reset and Reimport

```bash
# Step 1: Delete all orders and reset slots
node delete-all-orders-and-reset.js

# Step 2: Wait for completion message

# Step 3: Place your Excel file in the project root or uploads folder

# Step 4: Run import script
node import-all-booking.js

# Step 5: Check import results and error files (if any)
# - import-failures.json (detailed errors)
# - import-failures.xlsx (Excel with errors)
```

## Troubleshooting

### Import Errors

If import fails, check:
1. **Excel Format**: Ensure columns match required format
2. **Date Format**: Dates should be in MM/DD/YY or similar format
3. **Plant Names**: Must match exactly with Plant CMS data
4. **Subtype Names**: Must match exactly with plant subtypes
5. **Error Files**: Check `import-failures.json` and `import-failures.xlsx` for details

### Slot Matching Issues

If slots aren't matched:
- Script tries multiple date offsets (±0, ±7, ±14 days)
- Ensure delivery dates are within slot date ranges
- Check that plants and subtypes exist in CMS

### Database Connection Issues

If connection fails:
- Check `MONGO_URL` or `MONGODB_URI` in `.env` file
- Ensure MongoDB is running
- Verify database credentials

## Alternative Scripts

### Delete Only Orders (No Slot Reset)
```bash
node delete-orders.js
```

### Delete Orders and Reset Slots
```bash
node delete-orders-reset-slots.js
```

### Delete All Business Data (Including Inventory)
```bash
node delete-all-business-data.js
```

## Verification After Cleanup

After running the cleanup script, verify:

1. **Order Count**: Should be 0
   ```bash
   # Check in MongoDB or through API
   ```

2. **Slot Reset**: Check a sample slot
   - `totalBookedPlants` = 0
   - `orders` array = []
   - `overflow` = false

3. **Data Preservation**: Verify users and plants still exist

## Notes

- ⚠️ Always backup your database before running cleanup scripts
- 📊 Script shows counts before deletion
- ⏳ 3-second delay before deletion (press Ctrl+C to cancel)
- ✅ Script verifies cleanup at the end
- 📝 Error logs are saved for troubleshooting

## Support

For issues or questions:
1. Check error logs in console output
2. Review `import-failures.json` for import errors
3. Verify Excel file format matches requirements
4. Ensure all plants and subtypes exist in Plant CMS





