#!/bin/bash

# Test script to verify slot update functionality
# Usage: ./test-purchase-order-slot-update.sh

echo "🧪 Testing Purchase Order with Slot Update"
echo "=========================================="
echo ""

# Check if server is running
echo "1. Checking if server is running..."
if curl -s http://localhost:8000/api/v1/user/aboutMe > /dev/null 2>&1; then
    echo "   ✅ Server is running"
else
    echo "   ❌ Server is not running on port 8000"
    echo "   Please start the server first:"
    echo "   cd FINAL_NURSERY_BE && npm start"
    exit 1
fi

echo ""
echo "2. Creating Purchase Order with slotId..."
echo ""

# Replace with your actual token
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2ODY5ZmYwNzllNTJlZmU2MTg0YWVjM2EiLCJwaG9uZU51bWJlciI6NzU4ODY4NjQ1Miwicm9sZSI6IlNVUEVSX0FETUlOIiwiam9iVGl0bGUiOiJPRkZJQ0VfQURNSU4iLCJuYW1lIjoiU3VwZXIgQWRtaW4iLCJ0eXBlIjoiYWNjZXNzIiwiaWF0IjoxNzY2MTk1ODMwLCJleHAiOjE3NjYyODIyMzAsImF1ZCI6Im51cnNlcnktdXNlcnMiLCJpc3MiOiJudXJzZXJ5LWFwcCJ9.5H-z_63khsSNSYPiw3uiBogzYRjnlBZqLltCd3ewo7A"
SLOT_ID="6946c003417da3a25907ab93"

RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
  -X POST 'http://localhost:8000/api/v1/inventory/purchase-orders' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "supplier": "693e728197c787c12366d779",
    "expectedDeliveryDate": "2026-01-05",
    "items": [{
      "product": "6946c2ba5613d244ee2e02d6",
      "unit": "68f4d2ef2b62e89ab89bfcea",
      "quantity": 100000,
      "rate": 0,
      "amount": 0,
      "gst": 0,
      "discount": 0,
      "batchNumber": "",
      "expiryDate": null,
      "slotId": "'$SLOT_ID'"
    }],
    "notes": "",
    "autoGRN": true
  }')

HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS/d')

echo "HTTP Status: $HTTP_STATUS"
echo ""
echo "Response:"
echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
echo ""

if [ "$HTTP_STATUS" = "201" ] || [ "$HTTP_STATUS" = "200" ]; then
    echo "✅ Purchase Order created successfully!"
    echo ""
    echo "3. Checking server logs for slot update..."
    echo "   Look for these log messages:"
    echo "   - 📦 PO Item has slotId: $SLOT_ID"
    echo "   - 🔄 Attempting to update slot $SLOT_ID"
    echo "   - ✅ Updated slot $SLOT_ID availablePlants by +100000"
    echo ""
    echo "4. To verify slot was updated, run:"
    echo "   node scripts/check-slot-update.js $SLOT_ID"
else
    echo "❌ Purchase Order creation failed"
    echo "   Check the error message above"
fi

