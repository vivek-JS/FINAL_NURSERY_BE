# 🧪 Test "नमस्कार भाऊ" - cURL Command

## 🚀 Quick Test

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

## 📱 Expected Response

The bot will send this message via WATI API:

```
नमस्कार भाऊ!! 👋🙏

🌱 Nursery Order System मध्ये आपले स्वागत आहे!

कृपया एक पर्याय निवडा:

1️⃣ नवीन ऑर्डर
2️⃣ माझ्या ऑर्डर
3️⃣ मदत
```

## 🔗 What Bot Sends to WATI

```
POST https://live-mt-server.wati.io/385403/api/v1/sendSessionMessage/917588686453?messageText=नमस्कार%20भाऊ!!%20👋🙏%0A%0A🌱%20Nursery%20Order%20System%20मध्ये%20आपले%20स्वागत%20आहे!%0A%0Aकृपया%20एक%20पर्याय%20निवडा:%0A%0A1️⃣%20नवीन%20ऑर्डर%0A2️⃣%20माझ्या%20ऑर्डर%0A3️⃣%20मदत
Authorization: Bearer {TOKEN}
```

## ✅ Response from Your Server

```json
{"success": true}
```

---

## 🎯 One-Liner Version

```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook -H "Content-Type: application/json" -d '{"eventType":"message","type":"text","text":"Hi","waId":"917588686453","senderName":"Vivek"}'
```

