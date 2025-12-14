#!/bin/bash

# Test WATI Session Message AFTER creating active session
# 
# INSTRUCTIONS:
# 1. First, send a WhatsApp message FROM 917588686453 TO your WATI number
# 2. Wait 5-10 seconds
# 3. Run this script: ./test-session-after-message.sh

WATI_URL="https://live-mt-server.wati.io/385403"
WATI_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIwNjY4YWY5Zi1jN2I1LTQ2N2QtOWU0Yi01ZjRjOTJhNThlZjMiLCJ1bmlxdWVfbmFtZSI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwibmFtZWlkIjoidml2ZWtjLmFwa0BnbWFpbC5jb20iLCJlbWFpbCI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwiYXV0aF90aW1lIjoiMDkvMjEvMjAyNSAwNDo1ODozMiIsInRlbmFudF9pZCI6IjM4NTQwMyIsImRiX25hbWUiOiJtdC1wcm9kLVRlbmFudHMiLCJodHRwOi8vc2NoZW1hcy5taWNyb3NvZnQuY29tL3dzLzIwMDgvMDYvaWRlbnRpdHkvY2xhaW1zL3JvbGUiOiJBRE1JTklTVFJBVE9SIiwiZXhwIjoyNTM0MDIzMDA4MDAsImlzcyI6IkNsYXJlX0FJIiwiYXVkIjoiQ2xhcmVfQUkifQ.zAP3ZxQXUO1NWJGLe0e39qVeiXLK_d8U2y0bonMjomw"
PHONE="917588686453"

echo "🧪 Testing WATI Session Message..."
echo ""
echo "⚠️  IMPORTANT: Make sure you've sent a message FROM ${PHONE} TO your WATI number first!"
echo "   (This creates the active session required for sendSessionMessage)"
echo ""
read -p "Press Enter to continue after sending the message..."

curl -X POST "${WATI_URL}/api/v1/sendSessionMessage/${PHONE}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer ${WATI_TOKEN}" \
  -d '{"text":"✅ Test message after creating session"}' \
  -v

echo ""
echo ""
echo "✅ If you see result:true, the session is active and working!"


