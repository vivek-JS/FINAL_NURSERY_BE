# Testing Guide: Opt-In Webhook

## Overview
This guide explains how to test the opt-in/opt-out webhook endpoint that integrates with Wati.

## Webhook Endpoint

**URL:** `POST /api/v1/opt-in/webhook`  
**Health Check:** `GET /api/v1/opt-in/webhook`

**Production URL:** `https://final-nursery-be-1.onrender.com/api/v1/opt-in/webhook`  
**Local URL:** `http://localhost:8000/api/v1/opt-in/webhook`

---

## 1. Health Check Test

Test if the endpoint is accessible:

```bash
# Production
curl -X GET https://final-nursery-be-1.onrender.com/api/v1/opt-in/webhook

# Local
curl -X GET http://localhost:8000/api/v1/opt-in/webhook
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

## 2. Test Opt-In Event

### Format 1: Standard Wati Format
```bash
curl -X POST https://final-nursery-be-1.onrender.com/api/v1/opt-in/webhook \
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
curl -X POST https://final-nursery-be-1.onrender.com/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "opt_in",
    "waId": "919876543210"
  }'
```

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

## 3. Test Opt-Out Event

```bash
curl -X POST https://final-nursery-be-1.onrender.com/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "opt_out",
    "data": {
      "waId": "919876543210",
      "timestamp": "1234567890"
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

## 4. Test with Real Phone Numbers

Replace `9876543210` with actual phone numbers from your database:

```bash
# Test opt-in for a farmer that exists
curl -X POST https://final-nursery-be-1.onrender.com/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "opt_in",
    "data": {
      "waId": "917588686453"
    }
  }'
```

---

## 5. Test Edge Cases

### Invalid Event Type
```bash
curl -X POST https://final-nursery-be-1.onrender.com/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "invalid_event",
    "data": {
      "waId": "919876543210"
    }
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Webhook received but event type not recognized",
  "receivedEvent": "invalid_event"
}
```

### Missing Phone Number
```bash
curl -X POST https://final-nursery-be-1.onrender.com/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "opt_in",
    "data": {}
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Webhook received but phone number not found"
}
```

### Invalid Phone Number Format
```bash
curl -X POST https://final-nursery-be-1.onrender.com/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "opt_in",
    "data": {
      "waId": "12345"
    }
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Webhook received but phone number format is invalid",
  "receivedWaId": "12345"
}
```

---

## 6. Verify Database Updates

### Check Farmer Collection
```javascript
// In MongoDB shell or MongoDB Compass
db.farmers.findOne({ mobileNumber: 9876543210 })

// Should show:
{
  "_id": ObjectId("..."),
  "name": "...",
  "mobileNumber": 9876543210,
  "opt_in": true,  // or false for opt_out
  ...
}
```

### Check FarmerLead Collection
```javascript
db.farmerleads.findOne({ mobileNumber: "9876543210" })

// Should show:
{
  "_id": ObjectId("..."),
  "name": "...",
  "mobileNumber": "9876543210",
  "opt_in": true,  // or false for opt_out
  ...
}
```

### Query All Opted-In Farmers
```javascript
// Find all farmers who have opted in
db.farmers.find({ opt_in: true })

// Find all farmers who have opted out
db.farmers.find({ opt_in: false })
```

---

## 7. Test with Wati Dashboard

### Step 1: Configure Webhook in Wati
1. Go to Wati Dashboard: https://app.wati.io/settings/webhooks
2. Click "Add Webhook" or "Create Webhook"
3. Enter webhook URL: `https://final-nursery-be-1.onrender.com/api/v1/opt-in/webhook`
4. Select events:
   - ✅ `opt_in` (when user opts in)
   - ✅ `opt_out` (when user opts out)
5. Save the webhook

### Step 2: Test Webhook
1. In Wati dashboard, click "Test Webhook" button
2. Check your server logs (Render dashboard → Logs)
3. Verify the webhook was received and processed

### Step 3: Monitor Logs
Check Render logs for webhook activity:
```
📥 [OPT-IN WEBHOOK] Received webhook from Wati
📱 [OPT-IN WEBHOOK] Processing opt_in for phone: 9876543210
✅ [OPT-IN WEBHOOK] Update completed:
   Event: opt_in
   Phone: 9876543210
   opt_in value: true
   Farmers updated: 1
   FarmerLeads updated: 0
```

---

## 8. Testing Checklist

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
- [ ] Logs show detailed information for debugging
- [ ] Database indexes are created for `opt_in` field

---

## 9. Local Testing

If testing locally:

```bash
# Start your server
npm start
# or
node server.js

# Test locally
curl -X POST http://localhost:8000/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "opt_in",
    "data": {
      "waId": "919876543210"
    }
  }'
```

---

## 10. Troubleshooting

### Webhook Not Receiving Requests
1. Check if server is running: `GET /api/v1/opt-in/webhook` (health check)
2. Verify webhook URL in Wati dashboard
3. Check Render logs for incoming requests
4. Verify CORS settings if testing from browser

### Updates Not Reflecting in Database
1. Check server logs for errors
2. Verify phone number format matches database format
3. Check if farmer exists with that phone number
4. Verify MongoDB connection is working

### Phone Number Not Found
- Check if phone number exists in `Farmer` or `FarmerLead` collections
- Verify phone number format (10 digits, with/without country code)
- Check logs for normalization issues

---

## 11. Example Test Script

Save this as `test-opt-in-webhook.sh`:

```bash
#!/bin/bash

BASE_URL="https://final-nursery-be-1.onrender.com"
# For local: BASE_URL="http://localhost:8000"

echo "Testing Opt-In Webhook..."
echo "=========================="

echo -e "\n1. Health Check:"
curl -X GET "$BASE_URL/api/v1/opt-in/webhook"

echo -e "\n\n2. Test Opt-In:"
curl -X POST "$BASE_URL/api/v1/opt-in/webhook" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "opt_in",
    "data": {
      "waId": "919876543210"
    }
  }'

echo -e "\n\n3. Test Opt-Out:"
curl -X POST "$BASE_URL/api/v1/opt-in/webhook" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "opt_out",
    "data": {
      "waId": "919876543210"
    }
  }'

echo -e "\n\nDone!"
```

Make it executable and run:
```bash
chmod +x test-opt-in-webhook.sh
./test-opt-in-webhook.sh
```

---

## 12. Monitoring

Monitor webhook activity in Render logs:
1. Go to Render Dashboard
2. Select your service: `final-nursery-be-1`
3. Click "Logs" tab
4. Filter for: `OPT-IN WEBHOOK`

Look for:
- `📥 [OPT-IN WEBHOOK] Received webhook from Wati` - Webhook received
- `✅ [OPT-IN WEBHOOK] Update completed` - Success
- `❌ [OPT-IN WEBHOOK] Error updating opt-in status` - Error occurred

---

## Notes

- The webhook always returns `200 OK` to prevent Wati from retrying failed requests
- Phone numbers are normalized to 10-digit format (removes "91" country code)
- Both `Farmer` and `FarmerLead` collections are updated if phone number matches
- All webhook requests are logged for debugging purposes
