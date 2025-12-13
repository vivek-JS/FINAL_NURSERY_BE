# 🧪 How to Test the Webhook

## ⚠️ Server Must Be Running First!

### Step 1: Start Your Backend Server

**Terminal 1:**
```bash
cd FINAL_NURSERY_BE
npm start
```

Wait for: `Server running on port 8000`

---

## 🚀 Test Methods

### **Method 1: Quick Shell Script** (Easiest)

**Terminal 2:**
```bash
cd FINAL_NURSERY_BE
./run-test.sh
```

---

### **Method 2: Node.js Test Script**

**Terminal 2:**
```bash
cd FINAL_NURSERY_BE
node test-webhook-local.js
```

---

### **Method 3: Manual cURL Test**

**Terminal 2:**
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

**Expected Response:**
```json
{"success": true}
```

---

## ✅ What to Look For

### **In Server Logs (Terminal 1):**

You should see:
```
============================================================
📥 [2025-01-XX] Webhook Received
============================================================
Event: message
Data: {
  "waId": "919876543210",
  "text": {
    "body": "ORDER"
  }
}
============================================================

✅ Processing order flow for: 9876543210
✅ Step: welcome
```

### **In Test Output (Terminal 2):**

You should see:
```
✅ Success!
Response: {"success": true}
```

---

## 🐛 Troubleshooting

### **"Server is not running"**
- Make sure `npm start` is running in another terminal
- Check port 8000 is not used by another process

### **"Cannot POST /api/v1/whatsapp-order/webhook"**
- Verify route is registered in `app.js`
- Restart the server after adding the route

### **"Connection refused"**
- Server might not be started
- Check if server is running: `lsof -i :8000`

---

## 📝 Next: Test with ngrok (for Wati)

Once local test works:

1. **Start ngrok:**
   ```bash
   ngrok http 8000
   ```

2. **Copy ngrok URL** (e.g., `https://abc123.ngrok.io`)

3. **Configure in Wati:**
   - Go to: https://app.wati.io/settings/webhooks
   - Add: `https://abc123.ngrok.io/api/v1/whatsapp-order/webhook`

4. **Send WhatsApp message** "ORDER" to your Wati number

---

**Ready to test! Start your server first, then run any test method above.**


