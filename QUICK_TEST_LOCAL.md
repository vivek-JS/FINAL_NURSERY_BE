# 🚀 Quick Local Webhook Test

## Step 1: Start Your Server

Open a terminal and run:

```bash
cd FINAL_NURSERY_BE
npm run dev
```

**Wait for:**
```
Connected to database
Server running on port 8000
```

## Step 2: Test the Webhook

**In a NEW terminal window**, run:

```bash
cd FINAL_NURSERY_BE
node test-webhook-local-simple.js
```

**OR use cURL:**

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

## Step 3: Check Server Logs

In your server terminal, you should see:

```
🌐🌐🌐 INCOMING REQUEST TO WEBHOOK 🌐🌐🌐
✅✅✅ WEBHOOK ROUTE HIT ✅✅✅
🔥🔥 RAW WATI WEBHOOK RECEIVED 🔥🔥
```

## ✅ Expected Response

```json
{"success":true}
```

## ❌ Troubleshooting

### "Connection refused" or "Cannot connect"
- **Server not running** - Start with `npm run dev`
- **Wrong port** - Should be port 8000
- **MongoDB not connected** - Check your `.env` file

### "Cannot POST /api/v1/whatsapp-order/webhook-test"
- **Test endpoint not loaded** - Restart server after adding route
- **Use main webhook instead:** `/api/v1/whatsapp-order/webhook` (this always works)

### No logs appearing
- **Code not saved** - Save all files
- **Server not restarted** - Restart server after code changes
- **Check server console** - Logs appear in the terminal running `npm run dev`

## 🎯 Quick Test Commands

```bash
# 1. Health check (GET)
curl http://localhost:8000/api/v1/whatsapp-order/webhook

# 2. Main webhook (POST) - ALWAYS WORKS
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"event":"message","data":{"waId":"919876543210","text":{"body":"ORDER"}}}'

# 3. Run test script
node test-webhook-local-simple.js
```

## 📋 Checklist

- [ ] Server running (`npm run dev`)
- [ ] See "Server running on port 8000" message
- [ ] MongoDB connected
- [ ] Test with curl or test script
- [ ] Check server logs for log markers
- [ ] Get `{"success":true}` response

