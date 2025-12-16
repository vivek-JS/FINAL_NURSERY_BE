# Product API Response Example with Packets

## Endpoint
`GET /api/v1/inventory/products/:id`

## Example Response for Seeds Product

```json
{
  "success": true,
  "data": {
    "product": {
      "_id": "693e9776334dd3c44422f518",
      "code": "SEED-TOMATO-001",
      "name": "Tomato Seeds - Hybrid",
      "description": "High yield hybrid tomato seeds",
      "category": "seeds",
      "plantId": "60a1b2c3d4e5f6789012345a",
      "subtypeId": "60a1b2c3d4e5f6789012345b",
      "plant": {
        "_id": "60a1b2c3d4e5f6789012345a",
        "name": "Tomato"
      },
      "subtype": {
        "_id": "60a1b2c3d4e5f6789012345b",
        "name": "Hybrid"
      },
      "primaryUnit": {
        "_id": "60a1b2c3d4e5f6789012345c",
        "name": "Packets",
        "symbol": "pkt"
      },
      "secondaryUnit": null,
      "conversionFactor": 1,
      "minStockLevel": 10,
      "maxStockLevel": 1000,
      "reorderLevel": 50,
      "currentStock": 150,
      "stockValue": 15000,
      "averagePrice": 100,
      "hsn": "12099100",
      "gst": 5,
      "isActive": true,
      "createdBy": {
        "_id": "60a1b2c3d4e5f6789012345d",
        "name": "Admin User"
      },
      "updatedBy": null,
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-01-20T14:45:00.000Z"
    },
    "batches": [
      {
        "_id": "70b2c3d4e5f6789012345a",
        "batchNumber": "BATCH-2024-001",
        "product": "693e9776334dd3c44422f518",
        "quantity": 200,
        "receivedQuantity": 200,
        "remainingQuantity": 50,
        "receivedDate": "2024-01-10T00:00:00.000Z",
        "unit": {
          "_id": "60a1b2c3d4e5f6789012345c",
          "name": "Packets",
          "symbol": "pkt"
        },
        "supplier": {
          "_id": "80c3d4e5f6789012345a",
          "name": "Seed Supplier Co.",
          "phone": "+91-9876543210",
          "email": "supplier@example.com"
        },
        "costPrice": 100,
        "manufacturingDate": "2024-01-01T00:00:00.000Z",
        "expiryDate": "2025-12-31T00:00:00.000Z",
        "status": "active",
        "createdAt": "2024-01-10T10:00:00.000Z"
      }
    ],
    "recentTransactions": [
      {
        "_id": "90d4e5f6789012345a",
        "product": "693e9776334dd3c44422f518",
        "batch": {
          "_id": "70b2c3d4e5f6789012345a",
          "batchNumber": "BATCH-2024-001"
        },
        "transactionType": "inward",
        "quantity": 200,
        "unit": {
          "_id": "60a1b2c3d4e5f6789012345c",
          "name": "Packets"
        },
        "transactionDate": "2024-01-10T10:00:00.000Z",
        "performedBy": {
          "_id": "60a1b2c3d4e5f6789012345d",
          "name": "Admin User"
        }
      }
    ],
    "packets": [
      {
        "outwardId": "a0e5f6789012345a",
        "outwardNumber": "OUT24010001",
        "outwardDate": "2024-01-15T09:00:00.000Z",
        "itemId": "b1f6789012345a",
        "batch": {
          "_id": "70b2c3d4e5f6789012345a",
          "batchNumber": "BATCH-2024-001",
          "product": "693e9776334dd3c44422f518",
          "quantity": 200,
          "remainingQuantity": 50
        },
        "batchNumber": "BATCH-2024-001",
        "quantity": 100,
        "usedQuantity": 30,
        "availableQuantity": 70,
        "unit": {
          "_id": "60a1b2c3d4e5f6789012345c",
          "name": "Packets",
          "symbol": "pkt"
        },
        "rate": 100,
        "amount": 10000,
        "plant": {
          "_id": "60a1b2c3d4e5f6789012345a",
          "name": "Tomato"
        },
        "subtype": {
          "_id": "60a1b2c3d4e5f6789012345b",
          "name": "Hybrid"
        },
        "sowing": [
          {
            "_id": "c2f6789012345a",
            "plantId": {
              "_id": "60a1b2c3d4e5f6789012345a",
              "name": "Tomato"
            },
            "plantName": "Tomato",
            "subtypeId": "60a1b2c3d4e5f6789012345b",
            "subtypeName": "Hybrid",
            "sowingDate": "15-01-2024",
            "expectedReadyDate": "20-02-2024",
            "totalQuantityRequired": 500,
            "officeSowed": 30,
            "primarySowed": 0,
            "totalSowed": 30,
            "status": "PARTIALLY_SOWED",
            "orderId": {
              "_id": "d3f6789012345a",
              "orderNumber": "ORD-2024-001",
              "orderDate": "2024-01-10T00:00:00.000Z"
            },
            "orderNumber": "ORD-2024-001",
            "sowingLocation": "OFFICE",
            "notes": "Sowing in greenhouse section A"
          },
          {
            "_id": "c2f6789012345b",
            "plantId": {
              "_id": "60a1b2c3d4e5f6789012345a",
              "name": "Tomato"
            },
            "plantName": "Tomato",
            "subtypeId": "60a1b2c3d4e5f6789012345b",
            "subtypeName": "Hybrid",
            "sowingDate": "16-01-2024",
            "expectedReadyDate": "21-02-2024",
            "totalQuantityRequired": 300,
            "officeSowed": 0,
            "primarySowed": 0,
            "totalSowed": 0,
            "status": "PENDING",
            "orderId": {
              "_id": "d3f6789012345b",
              "orderNumber": "ORD-2024-002",
              "orderDate": "2024-01-12T00:00:00.000Z"
            },
            "orderNumber": "ORD-2024-002",
            "sowingLocation": "BOTH",
            "notes": "Pending sowing"
          }
        ]
      },
      {
        "outwardId": "a0e5f6789012345b",
        "outwardNumber": "OUT24010002",
        "outwardDate": "2024-01-18T10:00:00.000Z",
        "itemId": "b1f6789012345b",
        "batch": {
          "_id": "70b2c3d4e5f6789012345a",
          "batchNumber": "BATCH-2024-001",
          "product": "693e9776334dd3c44422f518",
          "quantity": 200,
          "remainingQuantity": 50
        },
        "batchNumber": "BATCH-2024-001",
        "quantity": 50,
        "usedQuantity": 50,
        "availableQuantity": 0,
        "unit": {
          "_id": "60a1b2c3d4e5f6789012345c",
          "name": "Packets",
          "symbol": "pkt"
        },
        "rate": 100,
        "amount": 5000,
        "plant": {
          "_id": "60a1b2c3d4e5f6789012345a",
          "name": "Tomato"
        },
        "subtype": {
          "_id": "60a1b2c3d4e5f6789012345b",
          "name": "Hybrid"
        },
        "sowing": [
          {
            "_id": "c2f6789012345c",
            "plantId": {
              "_id": "60a1b2c3d4e5f6789012345a",
              "name": "Tomato"
            },
            "plantName": "Tomato",
            "subtypeId": "60a1b2c3d4e5f6789012345b",
            "subtypeName": "Hybrid",
            "sowingDate": "18-01-2024",
            "expectedReadyDate": "23-02-2024",
            "totalQuantityRequired": 200,
            "officeSowed": 50,
            "primarySowed": 0,
            "totalSowed": 50,
            "status": "PARTIALLY_SOWED",
            "orderId": {
              "_id": "d3f6789012345c",
              "orderNumber": "ORD-2024-003",
              "orderDate": "2024-01-15T00:00:00.000Z"
            },
            "orderNumber": "ORD-2024-003",
            "sowingLocation": "OFFICE",
            "notes": "Fully used packet"
          }
        ]
      }
    ]
  }
}
```

## Key Features

### 1. Product Information
- Complete product details including `plant` and `subtype` objects
- Stock information, pricing, and unit details

### 2. Packets Array
Each packet includes:
- **Outward Information**: `outwardId`, `outwardNumber`, `outwardDate`
- **Batch Details**: Full batch information with batch number
- **Quantity Tracking**: 
  - `quantity`: Total quantity in packet
  - `usedQuantity`: Quantity already used
  - `availableQuantity`: Remaining available quantity
- **Plant & Subtype**: Direct reference to plant and subtype for each packet
- **Sowing Array**: All sowings linked to this packet with:
  - Plant and subtype information
  - Sowing dates and expected ready dates
  - Quantity tracking (officeSowed, primarySowed, totalSowed)
  - Status and order information
  - Location and notes

### 3. All Packets Included
- **Available Packets**: `availableQuantity > 0` (can still be used)
- **Used Packets**: `availableQuantity = 0` (fully used, but shows history)

### 4. Sowing Details
Each sowing in the array includes:
- Plant and subtype information (with populated plantId)
- Order information (with populated orderId)
- Sowing dates and status
- Quantity breakdown (office vs primary)
- Location and notes

## Usage Notes

1. **Available Packets**: Filter packets where `availableQuantity > 0` for sowing operations
2. **Used Packets**: Packets with `availableQuantity = 0` show complete usage history
3. **Sowing Tracking**: Each packet shows all sowings that have used it
4. **Plant/Subtype**: Available at both product level and packet level for flexibility

