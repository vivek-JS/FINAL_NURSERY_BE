# ⚡ Quick cURL Test Commands

## 🚀 One-Liner Tests

### Test 1: Start Conversation (Hi)
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook -H "Content-Type: application/json" -d '{"eventType":"message","type":"text","text":"Hi","waId":"917588686453","senderName":"Vivek"}'
```

### Test 2: New Order
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook -H "Content-Type: application/json" -d '{"eventType":"message","type":"text","text":"1","waId":"917588686453","senderName":"Vivek"}'
```

### Test 3: Select Plant
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook -H "Content-Type: application/json" -d '{"eventType":"message","type":"text","text":"1","waId":"917588686453","senderName":"Vivek"}'
```

### Test 4: Cancel
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook -H "Content-Type: application/json" -d '{"eventType":"message","type":"text","text":"cancel","waId":"917588686453","senderName":"Vivek"}'
```

### Test 5: Help
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook -H "Content-Type: application/json" -d '{"eventType":"message","type":"text","text":"help","waId":"917588686453","senderName":"Vivek"}'
```

---

## 📋 What Happens After Each Request

### After "Hi" is sent:
1. ✅ Bot receives webhook
2. ✅ Bot sends: "👋 Hello! Welcome to Nursery Order System 🌱..."
3. ✅ Returns `{"success": true}` to WATI

### After "1" (New Order) is sent:
1. ✅ Bot receives webhook
2. ✅ Bot queries database for plants
3. ✅ Bot sends: "🌱 Select Plant: 1️⃣ Banana 2️⃣ Papaya..."
4. ✅ Returns `{"success": true}` to WATI

---

## 🔍 Check Logs

After running any curl, check your terminal for:

```
🔥🔥🔥 RAW WATI WEBHOOK RECEIVED 🔥🔥🔥
📩 [WEBHOOK] Incoming WhatsApp Message
📤 [WATI] Preparing to send WhatsApp message...
🔗 Constructed URL: https://live-mt-server.wati.io/385403/api/v1/sendSessionMessage/917588686453?messageText=...
✅ Message sent successfully
```

---

## 📝 WATI API Call Format

**What the bot sends to WATI:**
```
POST https://live-mt-server.wati.io/385403/api/v1/sendSessionMessage/917588686453?messageText=Hello%20World
Authorization: Bearer {TOKEN}
```

**No body, just query parameter!**

