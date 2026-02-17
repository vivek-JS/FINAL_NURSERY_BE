# Production Testing Guide for Opt-In Webhook

## Production API Base URL
**Base URL:** `https://api1.rambiotechplants.com/api/v1/`  
**Webhook Endpoint:** `https://api1.rambiotechplants.com/api/v1/opt-in/webhook`

---

## Quick Test Commands

### 1. Health Check (Verify Endpoint is Live)
```bash
curl -X GET https://api1.rambiotechplants.com/api/v1/opt-in/webhook
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Opt-in webhook endpoint is active",
  "timestamp": "2026-02-17T10:30:00.000Z",
  "endpoint": "/api/v1/opt-in/webhook"
}
```

---

### 2. Test Opt-In Event
```bash
curl -X POST https://api1.rambiotechplants.com/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "opt_in",
    "data": {
      "waId": "919876543210"
    }
  }'
```

**Replace `9876543210` with a real phone number from your production database.**

**Expected Response:**
```json
{
  "success": true,
  "message": "Opt-in status updated successfully",
  "event": "opt_in",
  "phoneNumber": "9876543210",
  "optIn": true,
  "farmersUpdated": 1,
  "farmerLeadsUpdated": 0,
  "totalMatched": 1
}
```

---

### 3. Test Opt-Out Event
```bash
curl -X POST https://api1.rambiotechplants.com/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "opt_out",
    "data": {
      "waId": "919876543210"
    }
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Opt-in status updated successfully",
  "event": "opt_out",
  "phoneNumber": "9876543210",
  "optIn": false,
  "farmersUpdated": 1,
  "farmerLeadsUpdated": 0,
  "totalMatched": 1
}
```

---

## Test Script for Production

Save this as `test-production.sh`:

```bash
#!/bin/bash

BASE_URL="https://api1.rambiotechplants.com/api/v1"
PHONE="919876543210"  # Replace with real phone number from production DB

echo "🧪 Testing Opt-In Webhook on Production"
echo "======================================="
echo "API: $BASE_URL"
echo ""

echo -e "1️⃣  Health Check:"
curl -X GET "$BASE_URL/opt-in/webhook" | jq '.' 2>/dev/null || curl -X GET "$BASE_URL/opt-in/webhook"

echo -e "\n\n2️⃣  Test Opt-In:"
curl -X POST "$BASE_URL/opt-in/webhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"event\": \"opt_in\",
    \"data\": {
      \"waId\": \"$PHONE\"
    }
  }" | jq '.' 2>/dev/null || curl -X POST "$BASE_URL/opt-in/webhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"event\": \"opt_in\",
    \"data\": {
      \"waId\": \"$PHONE\"
    }
  }"

echo -e "\n\n3️⃣  Test Opt-Out:"
curl -X POST "$BASE_URL/opt-in/webhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"event\": \"opt_out\",
    \"data\": {
      \"waId\": \"$PHONE\"
    }
  }" | jq '.' 2>/dev/null || curl -X POST "$BASE_URL/opt-in/webhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"event\": \"opt_out\",
    \"data\": {
      \"waId\": \"$PHONE\"
    }
  }"

echo -e "\n\n✅ Done! Check production logs and database."
```

Make it executable and run:
```bash
chmod +x test-production.sh
./test-production.sh
```

---

## Using Postman

1. **Create New Request**
   - Method: `POST`
   - URL: `https://api1.rambiotechplants.com/api/v1/opt-in/webhook`

2. **Headers:**
   - Key: `Content-Type`
   - Value: `application/json`

3. **Body (raw JSON):**
   ```json
   {
     "event": "opt_in",
     "data": {
       "waId": "919876543210"
     }
   }
   ```

4. **Click Send**

---

## Configure Wati Webhook

### Step 1: Go to Wati Dashboard
1. Navigate to: https://app.wati.io/settings/webhooks
2. Login with your Wati account

### Step 2: Add Webhook
1. Click **"Add Webhook"** or **"Create Webhook"**
2. **Webhook URL:** 
   ```
   https://api1.rambiotechplants.com/api/v1/opt-in/webhook
   ```
3. **Webhook Name:** 
   ```
   Ram BioTech Opt-In Webhook
   ```
4. **Events to Subscribe:**
   - ✅ `opt_in` (when user opts in)
   - ✅ `opt_out` (when user opts out)

### Step 3: Save and Test
1. Click **"Save"** or **"Create"**
2. Wati will send a test webhook
3. Check your production logs to verify receipt

---

## Monitor Production Logs

### Check Server Logs
1. Access your production server logs (Render, AWS, etc.)
2. Look for entries containing: `OPT-IN WEBHOOK`
3. You should see:
   ```
   📥 [OPT-IN WEBHOOK] Received webhook from Wati
   📱 [OPT-IN WEBHOOK] Processing opt_in for phone: 9876543210
   ✅ [OPT-IN WEBHOOK] Update completed
   ```

### Verify Database Updates
Connect to your production MongoDB and check:

```javascript
// Check Farmer collection
db.farmers.findOne({ mobileNumber: 9876543210 })

// Check FarmerLead collection
db.farmerleads.findOne({ mobileNumber: "9876543210" })

// Find all opted-in farmers
db.farmers.find({ opt_in: true }).count()

// Find all opted-out farmers
db.farmers.find({ opt_in: false }).count()
```

---

## Test Different Payload Formats

### Format 1: Standard Format
```bash
curl -X POST https://api1.rambiotechplants.com/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "opt_in",
    "data": {
      "waId": "919876543210",
      "timestamp": "1234567890"
    }
  }'
```

### Format 2: Direct eventType Format
```bash
curl -X POST https://api1.rambiotechplants.com/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "opt_in",
    "waId": "919876543210"
  }'
```

### Format 3: Nested Data Format
```bash
curl -X POST https://api1.rambiotechplants.com/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "event": "opt_in",
      "waId": "919876543210"
    }
  }'
```

---

## Testing Checklist

- [ ] Health check endpoint returns success
- [ ] Opt-in event updates `opt_in: true` in Farmer collection
- [ ] Opt-in event updates `opt_in: true` in FarmerLead collection
- [ ] Opt-out event updates `opt_in: false` in Farmer collection
- [ ] Opt-out event updates `opt_in: false` in FarmerLead collection
- [ ] Phone number normalization works (removes country code "91")
- [ ] Invalid event types are handled gracefully
- [ ] Missing phone numbers are handled gracefully
- [ ] Invalid phone number formats are handled gracefully
- [ ] Webhook returns 200 OK even on errors (prevents Wati retries)
- [ ] Production logs show detailed information
- [ ] Wati webhook is configured correctly
- [ ] Database indexes are working for `opt_in` field

---

## Troubleshooting

### Webhook Not Receiving Requests
1. ✅ Verify endpoint is accessible: `GET https://api1.rambiotechplants.com/api/v1/opt-in/webhook`
2. ✅ Check webhook URL in Wati dashboard
3. ✅ Verify SSL certificate is valid (https://)
4. ✅ Check production server logs for incoming requests
5. ✅ Verify CORS settings allow Wati requests

### Updates Not Reflecting in Database
1. ✅ Check production server logs for errors
2. ✅ Verify phone number format matches database format
3. ✅ Check if farmer exists with that phone number
4. ✅ Verify MongoDB connection is working
5. ✅ Check for database write permissions

### Phone Number Not Found
- Check if phone number exists in `Farmer` or `FarmerLead` collections
- Verify phone number format (10 digits, with/without country code)
- Check logs for normalization issues

---

## Example: Test with Real Production Data

```bash
# First, get a real phone number from your production database
# Then test:

curl -X POST https://api1.rambiotechplants.com/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "opt_in",
    "data": {
      "waId": "917588686453"
    }
  }'
```

---

## Security Notes

- ✅ Webhook endpoint is public (no authentication required) - this is correct for Wati
- ✅ Always returns 200 OK to prevent Wati retries
- ✅ Validates and sanitizes input
- ✅ Logs all requests for monitoring
- ✅ Handles errors gracefully

---

## Summary

**Production Webhook URL:**
```
https://api1.rambiotechplants.com/api/v1/opt-in/webhook
```

**Quick Test:**
```bash
curl -X GET https://api1.rambiotechplants.com/api/v1/opt-in/webhook
```

**Test Opt-In:**
```bash
curl -X POST https://api1.rambiotechplants.com/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{"event":"opt_in","data":{"waId":"919876543210"}}'
```

Happy Testing! 🚀
