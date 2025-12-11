# 🚀 Quick Test Guide

## Step 1: Start Your Server

Open a terminal and run:

```bash
cd FINAL_NURSERY_BE
npm start
```

Wait for: `Server running on port 8000`

## Step 2: Run Test (in another terminal)

```bash
cd FINAL_NURSERY_BE
node test-webhook-local.js
```

## Step 3: Or Test with cURL

```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"event":"message","data":{"waId":"919876543210","text":{"body":"ORDER"}}}'
```

## Expected Output

You should see in server logs:
```
============================================================
📥 [timestamp] Webhook Received
============================================================
Event: message
Data: { ... }
============================================================
```

And response:
```json
{"success": true}
```

