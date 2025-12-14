#!/bin/bash

# ✅ CORRECT WATI Session Message cURL Command
# Uses --data-raw and "message" field (not "text")

WATI_URL="https://live-mt-server.wati.io/385403"
WATI_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIwNjY4YWY5Zi1jN2I1LTQ2N2QtOWU0Yi01ZjRjOTJhNThlZjMiLCJ1bmlxdWVfbmFtZSI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwibmFtZWlkIjoidml2ZWtjLmFwa0BnbWFpbC5jb20iLCJlbWFpbCI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwiYXV0aF90aW1lIjoiMDkvMjEvMjAyNSAwNDo1ODozMiIsInRlbmFudF9pZCI6IjM4NTQwMyIsImRiX25hbWUiOiJtdC1wcm9kLVRlbmFudHMiLCJodHRwOi8vc2NoZW1hcy5taWNyb3NvZnQuY29tL3dzLzIwMDgvMDYvaWRlbnRpdHkvY2xhaW1zL3JvbGUiOiJBRE1JTklTVFJBVE9SIiwiZXhwIjoyNTM0MDIzMDA4MDAsImlzcyI6IkNsYXJlX0FJIiwiYXVkIjoiQ2xhcmVfQUkifQ.zAP3ZxQXUO1NWJGLe0e39qVeiXLK_d8U2y0bonMjomw"
PHONE="917588686453"

echo "✅ Testing WATI Session Message with CORRECT format..."
echo ""

curl --location --request POST "${WATI_URL}/api/v1/sendSessionMessage/${PHONE}" \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer ${WATI_TOKEN}" \
  --data-raw '{
    "message": "✅ Correct format! Using --data-raw and message field."
  }'

echo ""
echo ""
echo "💡 Key points:"
echo "   ✅ Use --data-raw (not -d or --body)"
echo "   ✅ Use 'message' field (not 'text' or 'messageText')"
echo "   ✅ Phone must have active session (messaged WATI first)"


