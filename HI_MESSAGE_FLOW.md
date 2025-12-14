# 📱 "Hi" Message Flow - Complete cURL Example

## 🔄 Complete Flow

### Step 1: User sends "Hi" via WhatsApp
WATI sends webhook to your server:

```bash
# This is what WATI sends to your webhook endpoint
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

**Response from your server:**
```json
{"success": true}
```

---

### Step 2: Your bot processes and sends response via WATI API

**What your bot does internally:**
1. Receives webhook
2. Parses: Phone = `917588686453`, Message = `"Hi"`
3. Gets conversation state (creates new if first time)
4. Routes to `handleMainMenu()` function
5. Sends welcome message back via WATI API

**The WATI API call your bot makes (equivalent curl):**

```bash
# This is what YOUR BOT sends to WATI API
curl -X POST "https://live-mt-server.wati.io/385403/api/v1/sendSessionMessage/917588686453?messageText=👋%20Hello!%0A%0AWelcome%20to%20Nursery%20Order%20System%20🌱%0A%0APlease%20choose%20an%20option:%0A%0A1️⃣%20New%20Order%0A2️⃣%20My%20Orders%0A3️⃣%20Help" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIwNjY4YWY5Zi1jN2I1LTQ2N2QtOWU0Yi01ZjRjOTJhNThlZjMiLCJ1bmlxdWVfbmFtZSI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwibmFtZWlkIjoidml2ZWtjLmFwa0BnbWFpbC5jb20iLCJlbWFpbCI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwiYXV0aF90aW1lIjoiMDkvMjEvMjAyNSAwNDo1ODozMiIsInRlbmFudF9pZCI6IjM4NTQwMyIsImRiX25hbWUiOiJtdC1wcm9kLVRlbmFudHMiLCJodHRwOi8vc2NoZW1hcy5taWNyb3NvZnQuY29tL3dzLzIwMDgvMDYvaWRlbnRpdHkvY2xhaW1zL3JvbGUiOiJBRE1JTklTVFJBVE9SIiwiZXhwIjoyNTM0MDIzMDA4MDAsImlzcyI6IkNsYXJlX0FJIiwiYXVkIjoiQ2xhcmVfQUkifQ.zAP3ZxQXUO1NWJGLe0e39qVeiXLK_d8U2y0bonMjomw"
```

**Decoded message text:**
```
👋 Hello!

Welcome to Nursery Order System 🌱

Please choose an option:

1️⃣ New Order
2️⃣ My Orders
3️⃣ Help
```

**WATI API Response:**
```json
{
  "ok": true,
  "result": {
    "messageId": "wamid.xxx"
  }
}
```

---

## 📋 Complete Test Sequence

### Test the full flow:

```bash
# 1. Send "Hi" webhook to your server
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "message",
    "type": "text",
    "text": "Hi",
    "waId": "917588686453",
    "senderName": "Vivek"
  }'

# Expected response:
# {"success": true}
```

### What happens in your server logs:

```
🔥🔥🔥 RAW WATI WEBHOOK RECEIVED 🔥🔥🔥

📋 REQUEST INFO:
   Method: POST
   URL: /api/v1/whatsapp-order/webhook
   Timestamp: 2025-01-21T10:30:00.000Z

📦 REQUEST BODY:
{
  "eventType": "message",
  "type": "text",
  "text": "Hi",
  "waId": "917588686453",
  "senderName": "Vivek"
}

📩 Format 1 - New format detected
   Phone: 917588686453, Message: Hi, Sender: Vivek

📩 [WEBHOOK] Incoming WhatsApp Message
   📱 Phone: 917588686453
   📝 Message: "Hi"
   👤 Sender: Vivek
   🔢 Clean Mobile: 7588686453

🔄 [FLOW] Starting order flow processing...

📂 [STATE] Getting conversation state for: 7588686453
   🆕 Creating new state - Step: MAIN_MENU

📋 [STEP] MAIN_MENU Handler
   📝 Input: "hi"
   ✅ Trigger word detected - Showing welcome menu

📤 [WATI] Preparing to send WhatsApp message...
   📱 Input phone: 7588686453
   📝 Message length: 89 characters
   ✅ WATI_BASE_URL: https://live-mt-server.wati.io/385403
   ✅ WATI_TOKEN: eyJhbGciOiJIUzI1NiIs...
   🔢 Cleaned number: 7588686453
   ✅ Formatted phone: 7588686453
   🔗 Constructed URL: https://live-mt-server.wati.io/385403/api/v1/sendSessionMessage/917588686453?messageText=👋%20Hello!%0A%0AWelcome%20to%20Nursery%20Order%20System%20🌱%0A%0APlease%20choose%20an%20option:%0A%0A1️⃣%20New%20Order%0A2️⃣%20My%20Orders%0A3️⃣%20Help
   📋 URL breakdown:
      Base: https://live-mt-server.wati.io/385403
      Endpoint: /api/v1/sendSessionMessage/917588686453
      Query param: messageText=👋 Hello!...
      Encoded message length: 150 characters
   ✅ URL is valid
      Protocol: https:
      Host: live-mt-server.wati.io
      Path: /385403/api/v1/sendSessionMessage/917588686453
      Query: ?messageText=👋%20Hello!%0A%0AWelcome%20to%20Nursery%20Order%20System%20🌱%0A%0APlease%20choose%20an%20option:%0A%0A1️⃣%20New%20Order%0A2️⃣%20My%20Orders%0A3️⃣%20Help
   📤 Sending message to WATI API (using query parameter method)...
   📋 Request details:
      Method: POST
      URL: https://live-mt-server.wati.io/385403/api/v1/sendSessionMessage/917588686453?messageText=👋%20Hello!%0A%0AWelcome%20to%20Nursery%20Order%20System%20🌱%0A%0APlease%20choose%20an%20option:%0A%0A1️⃣%20New%20Order%0A2️⃣%20My%20Orders%0A3️⃣%20Help
      Headers: Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
      Body: NONE (using query parameter)
   📡 Response status: 200 OK
   ✅ Message sent successfully

✅ [FLOW] Order flow processing completed

📤 [RESPONSE] Sending 200 OK to WATI
```

---

## 🎯 Summary

**Input (Webhook from WATI):**
```json
{
  "eventType": "message",
  "text": "Hi",
  "waId": "917588686453"
}
```

**Output (Your bot sends to WATI API):**
```
POST https://live-mt-server.wati.io/385403/api/v1/sendSessionMessage/917588686453?messageText=👋%20Hello!%0A%0AWelcome%20to%20Nursery%20Order%20System%20🌱%0A%0APlease%20choose%20an%20option:%0A%0A1️⃣%20New%20Order%0A2️⃣%20My%20Orders%0A3️⃣%20Help
Authorization: Bearer {TOKEN}
```

**User receives on WhatsApp:**
```
👋 Hello!

Welcome to Nursery Order System 🌱

Please choose an option:

1️⃣ New Order
2️⃣ My Orders
3️⃣ Help
```

---

## 🔧 Test It Now

Run this command to test:

```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"Hi","waId":"917588686453","senderName":"Vivek"}'
```

Then check your server logs to see the complete flow and the WATI API call that was made!

