# Localhost Testing Guide for Opt-In Webhook

## Prerequisites

1. **Start your local server**
2. **Ensure MongoDB is connected** (check your `.env` file)
3. **Have test data** (farmers with phone numbers in your database)

---

## Step 1: Start Your Local Server

```bash
cd FINAL_NURSERY_BE

# Option 1: Start with nodemon (auto-restart on changes)
npm run dev

# Option 2: Start normally
npm start
```

**Expected Output:**
```
Server running on port 8000
Database connected successfully
```

**Default Local URL:** `http://localhost:8000`

---

## Step 2: Test Health Check Endpoint

Open a **new terminal** and run:

```bash
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

✅ If you see this, your endpoint is working!

---

## Step 3: Test Opt-In Event

### Test with a Real Phone Number from Your Database

First, check what phone numbers exist in your database:

```javascript
// In MongoDB Compass or MongoDB shell
db.farmers.findOne({}, { mobileNumber: 1, name: 1 })
db.farmerleads.findOne({}, { mobileNumber: 1, name: 1 })
```

Then test with that phone number:

```bash
# Replace 9876543210 with an actual phone number from your database
curl -X POST http://localhost:8000/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "opt_in",
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
  "event": "opt_in",
  "phoneNumber": "9876543210",
  "optIn": true,
  "farmersUpdated": 1,
  "farmerLeadsUpdated": 0,
  "totalMatched": 1
}
```

### Check Server Logs

In your server terminal, you should see:
```
============================================================
📥 [OPT-IN WEBHOOK] Received webhook from Wati
============================================================
   Timestamp: 2026-02-17T10:30:00.000Z
   Method: POST
   URL: /api/v1/opt-in/webhook
   ...

📱 [OPT-IN WEBHOOK] Processing opt_in for phone: 9876543210
   Original waId: 919876543210

✅ [OPT-IN WEBHOOK] Update completed:
   Event: opt_in
   Phone: 9876543210
   opt_in value: true
   Farmers updated: 1
   FarmerLeads updated: 0
   Total matched: 1
```

---

## Step 4: Test Opt-Out Event

```bash
curl -X POST http://localhost:8000/api/v1/opt-in/webhook \
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

## Step 5: Verify Database Updates

### Using MongoDB Compass

1. Open MongoDB Compass
2. Connect to your database
3. Navigate to `farmers` collection
4. Find document with `mobileNumber: 9876543210`
5. Check `opt_in` field - should be `true` (after opt_in) or `false` (after opt_out)

### Using MongoDB Shell

```javascript
// Connect to your database
use nursery  // or your database name

// Check Farmer collection
db.farmers.findOne({ mobileNumber: 9876543210 })

// Check FarmerLead collection
db.farmerleads.findOne({ mobileNumber: "9876543210" })

// Find all opted-in farmers
db.farmers.find({ opt_in: true })

// Find all opted-out farmers
db.farmers.find({ opt_in: false })
```

---

## Step 6: Test Different Payload Formats

### Format 1: Standard Format
```bash
curl -X POST http://localhost:8000/api/v1/opt-in/webhook \
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
curl -X POST http://localhost:8000/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "opt_in",
    "waId": "919876543210"
  }'
```

### Format 3: Nested Data Format
```bash
curl -X POST http://localhost:8000/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "event": "opt_in",
      "waId": "919876543210"
    }
  }'
```

---

## Step 7: Test Edge Cases

### Invalid Event Type
```bash
curl -X POST http://localhost:8000/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "invalid_event",
    "data": {
      "waId": "919876543210"
    }
  }'
```

### Missing Phone Number
```bash
curl -X POST http://localhost:8000/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "opt_in",
    "data": {}
  }'
```

### Invalid Phone Number
```bash
curl -X POST http://localhost:8000/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "opt_in",
    "data": {
      "waId": "12345"
    }
  }'
```

---

## Step 8: Using Postman (GUI Alternative)

1. **Open Postman**
2. **Create New Request**
   - Method: `POST`
   - URL: `http://localhost:8000/api/v1/opt-in/webhook`
3. **Headers:**
   - Key: `Content-Type`
   - Value: `application/json`
4. **Body:**
   - Select `raw` and `JSON`
   - Paste:
   ```json
   {
     "event": "opt_in",
     "data": {
       "waId": "919876543210"
     }
   }
   ```
5. **Click Send**

---

## Step 9: Using Browser (for GET requests only)

Open in browser:
```
http://localhost:8000/api/v1/opt-in/webhook
```

This will test the health check endpoint.

**Note:** POST requests need to be done via cURL, Postman, or similar tools.

---

## Step 10: Testing with ngrok (For Wati Webhook Testing)

If you want Wati to send webhooks to your localhost, use ngrok:

### Install ngrok
```bash
# macOS
brew install ngrok

# Or download from https://ngrok.com/download
```

### Start ngrok tunnel
```bash
ngrok http 8000
```

**Output:**
```
Forwarding  https://abc123.ngrok.io -> http://localhost:8000
```

### Use ngrok URL in Wati
1. Go to Wati Dashboard → Settings → Webhooks
2. Add webhook URL: `https://abc123.ngrok.io/api/v1/opt-in/webhook`
3. Select events: `opt_in` and `opt_out`
4. Save

Now Wati will send webhooks to your localhost via ngrok!

**Important:** Keep both your local server AND ngrok running.

---

## Quick Test Script

Save this as `test-localhost.sh`:

```bash
#!/bin/bash

BASE_URL="http://localhost:8000"
PHONE="919876543210"  # Replace with real phone number

echo "🧪 Testing Opt-In Webhook on Localhost"
echo "======================================="

echo -e "\n1️⃣  Health Check:"
curl -X GET "$BASE_URL/api/v1/opt-in/webhook" | jq '.'

echo -e "\n\n2️⃣  Test Opt-In:"
curl -X POST "$BASE_URL/api/v1/opt-in/webhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"event\": \"opt_in\",
    \"data\": {
      \"waId\": \"$PHONE\"
    }
  }" | jq '.'

echo -e "\n\n3️⃣  Test Opt-Out:"
curl -X POST "$BASE_URL/api/v1/opt-in/webhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"event\": \"opt_out\",
    \"data\": {
      \"waId\": \"$PHONE\"
    }
  }" | jq '.'

echo -e "\n\n✅ Done! Check your server logs and database."
```

Make it executable:
```bash
chmod +x test-localhost.sh
./test-localhost.sh
```

---

## Troubleshooting

### Server Not Starting
- Check if port 8000 is already in use: `lsof -i :8000`
- Check MongoDB connection in `.env`
- Check for syntax errors in code

### Webhook Returns Error
- Check server logs for detailed error messages
- Verify MongoDB is running and connected
- Check if phone number exists in database

### Database Not Updating
- Verify phone number format matches database
- Check MongoDB connection
- Look for errors in server logs
- Verify farmer exists with that phone number

### CORS Errors (if testing from browser)
- The webhook endpoint should work fine with cURL/Postman
- CORS is configured for production, localhost should work

---

## Expected Console Output

When testing, you should see in your server terminal:

```
✅✅✅ OPT-IN WEBHOOK ROUTE HIT ✅✅✅
   Route: POST /api/v1/opt-in/webhook
   Time: 2026-02-17T10:30:00.000Z
   Has Body: true
   Body Keys: event, data
✅✅✅ PROCEEDING TO CONTROLLER ✅✅✅

============================================================
📥 [OPT-IN WEBHOOK] Received webhook from Wati
============================================================
   Timestamp: 2026-02-17T10:30:00.000Z
   Method: POST
   URL: /api/v1/opt-in/webhook
   ...

📱 [OPT-IN WEBHOOK] Processing opt_in for phone: 9876543210
   Original waId: 919876543210

✅ [OPT-IN WEBHOOK] Update completed:
   Event: opt_in
   Phone: 9876543210
   opt_in value: true
   Farmers updated: 1
   FarmerLeads updated: 0
   Total matched: 1
```

---

## Summary

✅ **Health Check:** `GET http://localhost:8000/api/v1/opt-in/webhook`  
✅ **Opt-In:** `POST http://localhost:8000/api/v1/opt-in/webhook` with `"event": "opt_in"`  
✅ **Opt-Out:** `POST http://localhost:8000/api/v1/opt-in/webhook` with `"event": "opt_out"`  
✅ **Check Logs:** Watch your server terminal for detailed output  
✅ **Verify DB:** Check MongoDB for `opt_in` field updates

Happy Testing! 🚀
