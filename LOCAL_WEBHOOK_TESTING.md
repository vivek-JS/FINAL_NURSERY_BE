# 🧪 Local Webhook Testing Guide

## Quick Start

### Step 1: Start Your Server

```bash
cd FINAL_NURSERY_BE
npm run dev
```

**Expected output:**
```
Connected to database
Server running on port 8000
Server accessible at:
  - http://localhost:8000 (from this machine)
```

### Step 2: Test the Webhook

**Option A: Using the test script (Recommended)**

```bash
node test-webhook-local-simple.js
```

**Option B: Using cURL**

```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
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
  }'
```

**Option C: Using the existing test script**

```bash
node test-webhook-local.js
```

### Step 3: Check Server Logs

In your server console, you should see:

```
🌐🌐🌐 INCOMING REQUEST TO WEBHOOK 🌐🌐🌐
   Method: POST
   Path: /api/v1/whatsapp-order/webhook
   ...

✅✅✅ WEBHOOK ROUTE HIT ✅✅✅
   Route: POST /api/v1/whatsapp-order/webhook
   ...

🔥🔥 RAW WATI WEBHOOK RECEIVED 🔥🔥
📋 REQUEST INFO:
   Method: POST
   URL: /api/v1/whatsapp-order/webhook
   ...
📨 REQUEST HEADERS:
   ...
📦 REQUEST BODY:
   {
     "event": "message",
     "data": { ... }
   }
```

## Test Endpoints

### 1. Health Check (GET)
```bash
curl http://localhost:8000/api/v1/whatsapp-order/webhook
```

**Expected Response:**
```json
{
  "status": "success",
  "message": "WhatsApp webhook endpoint is active",
  "data": {
    "endpoint": "/api/v1/whatsapp-order/webhook",
    "method": "POST",
    "status": "ready"
  }
}
```

### 2. Test Endpoint (POST)
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook-test \
  -H "Content-Type: application/json" \
  -d '{"test":"data"}'
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Test endpoint working",
  "timestamp": "...",
  "body": {"test":"data"}
}
```

### 3. Main Webhook (POST)
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "message",
    "data": {
      "waId": "919876543210",
      "text": {
        "body": "ORDER"
      }
    }
  }'
```

**Expected Response:**
```json
{"success":true}
```

## Testing Different Scenarios

### Test 1: Welcome Message (ORDER)
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "message",
    "data": {
      "waId": "919876543210",
      "text": {"body": "ORDER"},
      "from": "919876543210"
    }
  }'
```

### Test 2: Button Reply
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "button_reply",
    "data": {
      "waId": "919876543210",
      "buttonText": "Yes, Place Order",
      "buttonId": "btn_0"
    }
  }'
```

### Test 3: Empty Body (Edge Case)
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Test 4: Invalid Format (Edge Case)
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"invalid":"data"}'
```

## What to Look For

### ✅ Success Indicators

1. **Server receives request:**
   - See `🌐🌐🌐 INCOMING REQUEST` in logs

2. **Route is hit:**
   - See `✅✅✅ WEBHOOK ROUTE HIT` in logs

3. **Controller processes:**
   - See `🔥🔥 RAW WATI WEBHOOK RECEIVED` in logs

4. **Response is sent:**
   - Get `{"success":true}` response

### ❌ Common Issues

1. **"Cannot connect to server"**
   - Server not running
   - Wrong port (should be 8000)
   - Check: `npm run dev`

2. **"Cannot POST /api/v1/whatsapp-order/webhook"**
   - Route not registered
   - Check app.js has route imported
   - Restart server

3. **No logs appearing**
   - Code not saved
   - Server not restarted
   - Check server console for errors

4. **Empty body in logs**
   - Content-Type header missing
   - Body not JSON formatted
   - Check curl command syntax

## Using ngrok for Wati Testing

If you want to test with real Wati webhooks locally:

### Step 1: Install ngrok
```bash
# macOS
brew install ngrok

# Or download from: https://ngrok.com/download
```

### Step 2: Start ngrok
```bash
ngrok http 8000
```

### Step 3: Copy ngrok URL
You'll get something like:
```
Forwarding: https://abc123.ngrok.io -> http://localhost:8000
```

### Step 4: Configure Wati
- Go to: https://app.wati.io/settings/webhooks
- Add webhook URL: `https://abc123.ngrok.io/api/v1/whatsapp-order/webhook`
- Test webhook from Wati dashboard

### Step 5: Test
- Send WhatsApp message to your Wati number
- Check your local server logs
- See all the detailed logs!

## Debugging Tips

1. **Watch server logs in real-time:**
   - Keep server console open
   - Send test request
   - Watch logs appear immediately

2. **Test incrementally:**
   - First test: Health check (GET)
   - Second test: Test endpoint (POST)
   - Third test: Main webhook (POST)

3. **Check each layer:**
   - Global logger (app.js) - catches all requests
   - Route logger (routes) - confirms route hit
   - Controller logger (controller) - detailed payload

4. **Compare with production:**
   - Test locally first
   - Then test on production
   - Compare logs between both

## Quick Test Commands

```bash
# 1. Health check
curl http://localhost:8000/api/v1/whatsapp-order/webhook

# 2. Test endpoint
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook-test \
  -H "Content-Type: application/json" \
  -d '{"test":"data"}'

# 3. Main webhook
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"event":"message","data":{"waId":"919876543210","text":{"body":"ORDER"}}}'

# 4. Run test script
node test-webhook-local-simple.js
```

## Next Steps

Once local testing works:
1. ✅ Verify all logs appear
2. ✅ Test different payload formats
3. ✅ Test edge cases (empty body, invalid data)
4. ✅ Deploy to production
5. ✅ Configure Wati webhook with production URL
6. ✅ Test with real WhatsApp messages


