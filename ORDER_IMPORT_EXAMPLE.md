# Order Import Example - Sushila Suresh Atre

## Excel Row Data (from image)

| Column | Value | Mapped To |
|--------|-------|-----------|
| Date | `1/25/25` | `orderBookingDate` → 2025-01-25 |
| Booking NO. | `0` | Auto-generated: `202501001` (Year + Month + Sequence) |
| Name | `Sushila Suresh Atre` | Farmer name |
| Mobile No. | `9404558601` | Farmer mobile (will find or create) |
| Address | `Fuknagari` | `village` |
| Taluka | `Jalgaon` | `taluka` |
| District | `Jalgaon` | `district` |
| Advance On | `5/16/25` | Payment date → 2025-05-16 |
| adv match | `FALSE` | (Not used in import) |
| Advance Amt. | `10000` | Payment amount → ₹10,000 |
| Crop | `Banana` | Plant → Banana |
| Variety | `G-9` | Subtype → G-9 |
| Media | `8 Cavity` | Cavity → 8 (will extract number, find or create tray) |
| Expected | `RB` | `expectedNursery` → "RB" |
| Plant Qty. | `19` | `numberOfPlants` → 19 |
| Rate | `8500` | `rate` → ₹8,500 |
| Expected Del. | `11/28/25` | `deliveryDate` → 2025-11-28 |
| Old Del. Date | `25-03-2025` | `oldDeliveryDate` & slot date → 2025-03-25 |
| Del. Y/N | `N` | `orderStatus` → ACCEPTED |
| Invoice amount | `161500` | (Calculated: 19 × 8500 = 161,500) |
| Bal. Amt. | `161500` | (Balance after payment) |
| Refrence | `Barde Sir` | `reference` → User/Employee lookup |
| Order By | `Barde Sir` | `salesPerson` → Sales person (will find or create) |
| Ad. Amt. Mode | `online` | Payment `modeOfPayment` → "online" |
| Bank | `` | Payment `bankName` → null |
| CH No. | `1341` | Payment `chequeNumber` → "1341" |
| Advance Date | `5/16/25` | Payment date (same as Advance On) |
| Receipt Code | `0` | (Not used in import) |
| ADV Y/N | `Y` | Payment `paymentStatus` → COLLECTED |
| CC Y/N | `` | (Not used in import) |
| Remark | Multi-line text | Payment `remark` |

## Import Process Flow

### 1. **Farmer Creation/Lookup**
   - Searches for farmer by mobile: `9404558601`
   - If not found, creates new farmer:
     - Name: `Sushila Suresh Atre`
     - Mobile: `9404558601`
     - Village: `Fuknagari`
     - Taluka: `Jalgaon`
     - District: `Jalgaon`
     - State: `Maharashtra`

### 2. **Plant & Subtype Lookup**
   - Plant: `Banana` (must exist in PlantCms)
   - Subtype: `G-9` (must exist in Banana subtypes)

### 3. **Tray (Cavity) Creation/Lookup**
   - Extracts cavity number from `"8 Cavity"` → `8`
   - Searches for tray with cavity = 8
   - If not found, creates new tray:
     - Name: `Media 8`
     - Cavity: `8`
     - numberPerCrate: `1` (default)
     - isActive: `true`

### 4. **Slot Determination**
   - **Old Del. Date is present** (`25-03-2025`)
   - Therefore:
     - `slotDate` = `2025-03-25` (used to find slot)
     - `deliveryDate` = `null` (set to N/A)
     - `oldDeliveryDate` = `2025-03-25`
   - Finds slot matching date `2025-03-25` for Banana G-9

### 5. **Order Status**
   - `Del. Y/N` = `N` → `orderStatus` = `ACCEPTED`

### 6. **Sales Person Creation/Lookup**
   - Searches for user/employee: `Barde Sir`
   - If not found, creates new sales person:
     - Name: `Barde Sir`
     - Phone: `9999999XXXX` (dummy number)
     - Role: `SALES`
     - Job Title: `SALES`

### 7. **Reference User Lookup**
   - Searches for user: `Barde Sir`
   - If found, sets `reference` field

### 8. **Order Creation**
   ```javascript
   {
     orderId: 202501001, // Auto-generated
     farmer: <Farmer ObjectId>,
     salesPerson: <Sales Person ObjectId>,
     reference: <User ObjectId or null>,
     numberOfPlants: 19,
     plantName: <Banana Plant ObjectId>,
     plantSubtype: <G-9 Subtype ObjectId>,
     bookingSlot: <Slot ObjectId for 2025-03-25>,
     cavity: <Tray ObjectId for 8 cavity>,
     rate: 8500,
     orderStatus: "ACCEPTED",
     orderBookingDate: 2025-01-25,
     deliveryDate: null, // N/A because Old Del. Date is present
     oldDeliveryDate: 2025-03-25,
     expectedNursery: "RB",
     orderPaymentStatus: "PENDING"
   }
   ```

### 9. **Payment Creation**
   ```javascript
   {
     paidAmount: 10000,
     paymentDate: 2025-05-16,
     paymentStatus: "COLLECTED", // ADV Y/N = Y
     modeOfPayment: "online",
     bankName: null,
     chequeNumber: "1341",
     remark: "Mukesh Suresh Atre Cahnge Name Add Quantity Ref Sandip P\nON Call 24/7/25\nlu 31/10\nLu 17/11",
     isWalletPayment: false
   }
   ```

## Expected Results

### Success Case:
- ✅ Order created with auto-generated orderId
- ✅ Farmer found or created
- ✅ Sales person found or created
- ✅ Tray (8 cavity) found or created
- ✅ Payment entry created with status COLLECTED
- ✅ Slot assigned based on Old Del. Date (2025-03-25)

### Auto-Created Entities:
- Farmer: `Sushila Suresh Atre` (if not exists)
- Sales Person: `Barde Sir` (if not exists)
- Tray: `Media 8` (if not exists)

## API Usage

### Endpoint:
```
POST /api/v1/excel/import-orders-with-payment
```

### Request:
- **Method**: POST
- **Content-Type**: multipart/form-data
- **Body**:
  - `file`: Excel file (.xlsx)
  - `password`: (optional) Password if file is password-protected

### Response:
```json
{
  "status": "success",
  "message": "Import completed: 1 successful, 0 failed",
  "data": {
    "success": 1,
    "failed": 0,
    "errors": [],
    "autoCreatedFarmers": [
      {
        "name": "Sushila Suresh Atre",
        "mobileNumber": "9404558601"
      }
    ],
    "autoCreatedSalesPersons": [
      {
        "name": "Barde Sir",
        "phoneNumber": "9999999XXXX"
      }
    ],
    "autoCreatedTrays": [
      {
        "name": "Media 8",
        "cavity": 8,
        "message": "Auto-created during import"
      }
    ],
    "skipped": []
  }
}
```

## Notes

1. **Booking NO. = 0**: Will be auto-generated as `YYYYMMXXX` format
2. **Old Del. Date present**: When Old Del. Date exists, it becomes the slot date and deliveryDate is set to null
3. **Media format**: Handles formats like "8 Cavity", "8", or just the number
4. **Payment status**: Y = COLLECTED, N = PENDING
5. **Order status**: N = ACCEPTED, Y = COMPLETED, C = CANCELLED
6. **Auto-creation**: System automatically creates missing farmers, sales persons, and trays

