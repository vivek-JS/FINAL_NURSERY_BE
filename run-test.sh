#!/bin/bash

echo "🧪 WhatsApp Webhook Test Script"
echo "================================"
echo ""

# Check if server is running
if ! curl -s http://localhost:8000 > /dev/null 2>&1; then
    echo "❌ Server is not running on port 8000"
    echo ""
    echo "Please start your server first:"
    echo "  cd FINAL_NURSERY_BE"
    echo "  npm start"
    echo ""
    echo "Then run this test script in another terminal."
    exit 1
fi

echo "✅ Server is running!"
echo ""
echo "Testing webhook endpoint..."
echo ""

# Test 1: Basic webhook test
echo "Test 1: Sending ORDER message..."
RESPONSE=$(curl -s -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "message",
    "data": {
      "waId": "919876543210",
      "text": {
        "body": "ORDER"
      },
      "from": "919876543210"
    }
  }')

echo "Response: $RESPONSE"
echo ""

if echo "$RESPONSE" | grep -q "success"; then
    echo "✅ Test 1 PASSED!"
else
    echo "❌ Test 1 FAILED!"
fi

echo ""
echo "================================"
echo "✅ Test completed!"
echo ""
echo "Check your server logs to see the webhook processing."



