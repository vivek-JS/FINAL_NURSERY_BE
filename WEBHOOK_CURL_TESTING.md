# 🧪 Webhook Testing with cURL

## 📋 What Happens After Webhook is Received

When a webhook is received, the bot:
1. ✅ Parses the webhook payload
2. ✅ Gets/creates conversation state
3. ✅ Processes the message through order flow
4. ✅ Sends WhatsApp message back via WATI API
5. ✅ Returns 200 OK to WATI

---

## 🔧 Localhost cURL Commands

### Base URL
```bash
BASE_URL="http://localhost:8000"
WEBHOOK_ENDPOINT="/api/v1/whatsapp-order/webhook"
```

---

## 📥 Test 1: Initial "Hi" Message (Format 1)

**What you send:**
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "message",
    "type": "text",
    "text": "Hi",
    "waId": "917588686453",
    "senderName": "Vivek"
  }'
```

**What bot sends back (via WATI API):**
```
POST https://live-mt-server.wati.io/385403/api/v1/sendSessionMessage/917588686453?messageText=👋%20Hello!%0A%0AWelcome%20to%20Nursery%20Order%20System%20🌱%0A%0APlease%20choose%20an%20option:%0A%0A1️⃣%20New%20Order%0A2️⃣%20My%20Orders%0A3️⃣%20Help
Headers:
  Authorization: Bearer {TOKEN}
Body: NONE
```

**Response to WATI:**
```json
{"success": true}
```

---

## 📥 Test 2: Start New Order (Option 1)

**What you send:**
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "message",
    "type": "text",
    "text": "1",
    "waId": "917588686453",
    "senderName": "Vivek"
  }'
```

**What bot sends back:**
```
POST https://live-mt-server.wati.io/385403/api/v1/sendSessionMessage/917588686453?messageText=🌱%20Select%20Plant:%0A%0A1️⃣%20Banana%0A2️⃣%20Papaya%0A3️⃣%20Watermelon%0A%0AReply%20with%20number
```

---

## 📥 Test 3: Select Plant (Option 1)

**What you send:**
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "message",
    "type": "text",
    "text": "1",
    "waId": "917588686453",
    "senderName": "Vivek"
  }'
```

**What bot sends back:**
```
POST https://live-mt-server.wati.io/385403/api/v1/sendSessionMessage/917588686453?messageText=✅%20Plant:%20Banana%0A%0ALoading%20varieties...
```

Then immediately sends:
```
POST https://live-mt-server.wati.io/385403/api/v1/sendSessionMessage/917588686453?messageText=🍃%20Banana%20varieties:%0A%0A1️⃣%20Grand%20Naine%20–%20₹5%0A2️⃣%20Robusta%20–%20₹6%0A%0ASelect%20variety
```

---

## 📥 Test 4: Cancel Command

**What you send:**
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "message",
    "type": "text",
    "text": "cancel",
    "waId": "917588686453",
    "senderName": "Vivek"
  }'
```

**What bot sends back:**
```
POST https://live-mt-server.wati.io/385403/api/v1/sendSessionMessage/917588686453?messageText=❌%20Order%20cancelled.%0A%0AType%20HI%20to%20start%20again.
```

---

## 📥 Test 5: Help Command

**What you send:**
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "message",
    "type": "text",
    "text": "help",
    "waId": "917588686453",
    "senderName": "Vivek"
  }'
```

**What bot sends back:**
```
POST https://live-mt-server.wati.io/385403/api/v1/sendSessionMessage/917588686453?messageText=📖%20*Help*%0A%0A•%20Type%20HI%20to%20start%0A•%20Type%20CANCEL%20to%20cancel%20anytime%0A•%20Type%20MENU%20to%20go%20to%20main%20menu%0A•%20Reply%20with%20numbers%20to%20select%20options
```

---

## 📥 Test 6: Complete Order Flow

### Step 1: Start
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"Hi","waId":"917588686453","senderName":"Vivek"}'
```

### Step 2: New Order
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"1","waId":"917588686453","senderName":"Vivek"}'
```

### Step 3: Select Plant
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"1","waId":"917588686453","senderName":"Vivek"}'
```

### Step 4: Select Variety
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"1","waId":"917588686453","senderName":"Vivek"}'
```

### Step 5: Select Cavity
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"2","waId":"917588686453","senderName":"Vivek"}'
```

### Step 6: Enter Quantity
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"500","waId":"917588686453","senderName":"Vivek"}'
```

### Step 7: Select Delivery Date
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"1","waId":"917588686453","senderName":"Vivek"}'
```

### Step 8: Confirm Order
```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"1","waId":"917588686453","senderName":"Vivek"}'
```

**After confirmation, bot sends:**
1. Processing message to user
2. Creates order via API
3. Success message to user
4. Admin notification to admin phone

---

## 🔍 What to Check in Logs

After running any curl command, check your server logs for:

1. **Webhook Received:**
   ```
   🔥🔥🔥 RAW WATI WEBHOOK RECEIVED 🔥🔥🔥
   📦 REQUEST BODY: {...}
   ```

2. **Message Parsed:**
   ```
   📩 [WEBHOOK] Incoming WhatsApp Message
   📱 Phone: 917588686453
   📝 Message: "Hi"
   ```

3. **WATI API Call:**
   ```
   📤 [WATI] Preparing to send WhatsApp message...
   🔗 Constructed URL: https://live-mt-server.wati.io/385403/api/v1/sendSessionMessage/917588686453?messageText=...
   📡 Response status: 200 OK
   ✅ Message sent successfully
   ```

---

## 🚀 Quick Test Script

Use the provided `test-webhook-curl.sh` script:

```bash
chmod +x test-webhook-curl.sh
./test-webhook-curl.sh
```

This will run all test scenarios automatically.

---

## 📝 Notes

- **All WATI API calls use query parameter method** (`?messageText=...`)
- **No JSON body** is sent to WATI API
- **Only Authorization header** is required
- **URL is logged** in full detail for debugging
- **Response is always 200 OK** to WATI (even if processing fails)

---

## 🔗 WATI API Format

The bot sends messages using this format:

```
POST {WATI_BASE_URL}/api/v1/sendSessionMessage/91{phone}?messageText={encodedMessage}
Headers:
  Authorization: Bearer {TOKEN}
Body: NONE
```

Example:
```
POST https://live-mt-server.wati.io/385403/api/v1/sendSessionMessage/917588686453?messageText=Hello%20World
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

