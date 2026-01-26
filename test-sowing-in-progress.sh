#!/bin/bash

# Test script for in-progress sowing cleanup
# Tests: packetsUsed, packetsToReturn, return request creation, slot clearing

BASE_URL="http://localhost:8000/api/v1"
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2OTQxOTIwN2UzYmYyZmIwYzVkODgwYzIiLCJwaG9uZU51bWJlciI6MTExMTEzMzMzMywicm9sZSI6IkZBUk1FUiIsImpvYlRpdGxlIjoiUFJJTUFSWSIsIm5hbWUiOiJSdXBlc2giLCJ0eXBlIjoiYWNjZXNzIiwiaWF0IjoxNzY1OTg1Nzg0LCJleHAiOjE3NjYwNzIxODQsImF1ZCI6Im51cnNlcnktdXNlcnMiLCJpc3MiOiJudXJzZXJ5LWFwcCJ9.DJGy406qJml9sEvkPUlc4xAD6ztBw3juXjB4zY-BQIQ"

echo "🧪 Testing In-Progress Sowing Cleanup"
echo "============================================================"
echo ""
echo "📋 Test Scenario:"
echo "  - In-progress sowing completion"
echo "  - packetsUsed: 4.0"
echo "  - packetsToReturn: 1.49"
echo "  - Expected: Return request created + sowingInProgress cleared from slot"
echo ""
echo "============================================================"
echo "🚀 Sending Request..."
echo ""

# Make the curl request with detailed output
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/sowing/multiple" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "sowings": [
      {
        "plantId": "691054dffba6fb380f8d57b3",
        "subtypeId": "6942ecd53fb8af33f581babb",
        "sowingDate": "18-12-2025",
        "totalQuantityRequired": 4.0,
        "sowedPlant": 400,
        "reminderBeforeDays": 5,
        "notes": "Test in-progress sowing cleanup",
        "batchNumber": "BATCHSAG251217956",
        "sowingLocation": "OFFICE",
        "slotId": "675a1f3e8c9b2a001f123456",
        "plantReadyDays": 20,
        "completeSowing": true,
        "packetsUsed": 4.0,
        "packetsToReturn": 1.49,
        "createdBy": "69419207e3bf2fb0c5d880c2"
      }
    ]
  }')

# Extract HTTP status code (last line)
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
# Extract response body (all but last line)
RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')

echo "============================================================"
echo "📊 Response:"
echo "============================================================"
echo "HTTP Status: $HTTP_CODE"
echo ""
echo "$RESPONSE_BODY" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE_BODY"
echo ""
echo "============================================================"

if [ "$HTTP_CODE" -eq 201 ] || [ "$HTTP_CODE" -eq 200 ]; then
  echo "✅ Request successful!"
  echo ""
  echo "🔍 Check backend logs for:"
  echo "  - [sowingInProgress] Extracted values"
  echo "  - [sowingInProgress] ✅ Found X in-progress entries"
  echo "  - [sowingInProgress] ✅ Creating return request"
  echo "  - [sowingInProgress] ✅ Marking X packets as used"
  echo "  - [sowingInProgress] ✅ Cleared sowingInProgress array"
  echo "  - [sowingInProgress] ✅ Slot updated successfully"
  echo ""
else
  echo "❌ Request failed with status $HTTP_CODE"
  echo ""
fi

echo "============================================================"




