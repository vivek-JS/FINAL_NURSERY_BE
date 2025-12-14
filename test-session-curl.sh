#!/bin/bash

# WATI Session Message Test - cURL Command
# Replace these values with your actual credentials

WATI_URL="https://live-mt-server.wati.io/385403"
WATI_TOKEN="YOUR_WATI_TOKEN_HERE"  # Replace with your actual token
PHONE="917588686453"  # Replace with phone number that has active session

echo "🧪 Testing WATI Session Message with cURL..."
echo ""

curl -X POST "${WATI_URL}/api/v1/sendSessionMessage/${PHONE}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer ${WATI_TOKEN}" \
  -d '{
    "text": "✅ cURL test successful! WATI session message works."
  }' \
  -v

echo ""
echo ""
echo "💡 TIP: Make sure the phone number has messaged your WATI number first!"
echo "   This creates an active session required for sendSessionMessage."


