#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2ODY5ZmYwNzllNTJlZmU2MTg0YWVjM2EiLCJwaG9uZU51bWJlciI6NzU4ODY4NjQ1Miwicm9sZSI6IlNVUEVSX0FETUlOIiwibmFtZSI6IlN1cGVyIEFkbWluIiwidHlwZSI6ImFjY2VzcyIsImlhdCI6MTc2MDc3MzU1MiwiZXhwIjoxNzYwODU5OTUyLCJhdWQiOiJudXJzZXJ5LXVzZXJzIiwiaXNzIjoibnVyc2VyeS1hcHAifQ.uYZG3X31Xpv2IKwovdsboymDEwC4ijbncTk9UN48X98"
BASE_URL="http://localhost:8000/api/v1"
MOBILE_NUMBER="1221122333"

echo -e "${BLUE}🔍 Checking if farmer exists with mobile: ${MOBILE_NUMBER}${NC}\n"

# Try to find the farmer
RESPONSE=$(curl -s "${BASE_URL}/farmer/getfarmer/${MOBILE_NUMBER}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json")

echo "Response:"
echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"

# Check if farmer was found
if echo "$RESPONSE" | grep -q '"status":"success"'; then
  echo -e "\n${GREEN}✅ Farmer EXISTS!${NC}"
  echo -e "\nFarmer Details:"
  echo "$RESPONSE" | jq '.data' 2>/dev/null
elif echo "$RESPONSE" | grep -q '"status":"fail"'; then
  echo -e "\n${RED}❌ Farmer NOT FOUND${NC}"
  echo -e "${YELLOW}The farmer from orderFor was not created.${NC}"
else
  echo -e "\n${RED}❌ Unexpected response${NC}"
fi

echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}💡 Debugging Steps:${NC}"
echo -e "1. Check backend console logs for orderFor messages"
echo -e "2. Look for: ${GREEN}✅ Successfully created new farmer from orderFor!${NC}"
echo -e "3. If you see: ${YELLOW}ℹ️ Farmer already exists${NC} - delete and retry"
echo -e "4. If you see: ${RED}❌ Error creating farmer${NC} - check the error details"
echo -e "5. If no logs appear - the code might not be executing"

