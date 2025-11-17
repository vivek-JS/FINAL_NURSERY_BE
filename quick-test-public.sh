#!/bin/bash

# Quick test script for public endpoints - no auth required

BASE_URL="${BASE_URL:-http://localhost:8000}"
API_BASE="${BASE_URL}/api/v1/public-links"

echo "🧪 Quick Test: Public Links Endpoints (NO AUTH)"
echo "================================================"
echo ""

# Test 1: Get config (should work without token)
echo "1️⃣  Testing GET /config/:slug (NO TOKEN)"
echo "   curl -X GET ${API_BASE}/config/jamner-watermelon"
RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X GET "${API_BASE}/config/jamner-watermelon" \
  -H "Accept: application/json")

HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS/d')

if echo "$BODY" | grep -qi "access token\|auth\|token required"; then
  echo "   ❌ FAILED: Still requires authentication"
  echo "   Response: $BODY"
else
  if [ "$HTTP_STATUS" == "200" ]; then
    echo "   ✅ SUCCESS: Got config without auth"
  elif [ "$HTTP_STATUS" == "404" ]; then
    echo "   ✅ OK: Endpoint accessible (slug just doesn't exist)"
  else
    echo "   ⚠️  Status: $HTTP_STATUS"
    echo "   Response: $BODY"
  fi
fi

echo ""

# Test 2: POST lead (should work without token)
echo "2️⃣  Testing POST /leads (NO TOKEN)"
echo "   curl -X POST ${API_BASE}/leads"
RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST "${API_BASE}/leads" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "slug": "jamner-watermelon",
    "name": "Test Farmer",
    "mobileNumber": "9876543210",
    "stateCode": "MH",
    "stateName": "Maharashtra",
    "districtCode": "MH_NAS",
    "districtName": "Nashik",
    "talukaCode": "MH_NAS_JAM",
    "talukaName": "Jamner",
    "villageName": "Test Village"
  }')

HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS/d')

if echo "$BODY" | grep -qi "access token\|auth\|token required"; then
  echo "   ❌ FAILED: Still requires authentication"
  echo "   Response: $BODY"
else
  if [ "$HTTP_STATUS" == "201" ]; then
    echo "   ✅ SUCCESS: Lead created without auth"
  elif [ "$HTTP_STATUS" == "400" ] || [ "$HTTP_STATUS" == "404" ]; then
    echo "   ✅ OK: Endpoint accessible (validation/not found error, but no auth error)"
  else
    echo "   ⚠️  Status: $HTTP_STATUS"
    echo "   Response: $BODY"
  fi
fi

echo ""
echo "✅ Quick test complete!"
echo ""

