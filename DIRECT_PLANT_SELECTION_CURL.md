# 🧪 Direct Plant Selection - cURL Test

## 🚀 Test Command

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

User will receive **TWO messages**:

### Message 1:
```
नमस्कार भाऊ!! 👋🙏🌱

🌱 Ram Biotech मध्ये आपले स्वागत आहे!
```

### Message 2 (immediately):
```
🌱 आपल्याला कोणती रोप बुक करायची आहे?

1️⃣ केळी (Keli)
2️⃣ पपया (Papaya)
3️⃣ तरबूज (Tarbooj)
4️⃣ खरबूज (Kharbooj)

नंबर टाइप करा
```

## 🎯 One-Liner Version

```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook -H "Content-Type: application/json" -d '{"eventType":"message","type":"text","text":"Hi","waId":"917588686453","senderName":"Vivek"}'
```

## ✅ Production Ready

The code is now configured to:
- ✅ Skip menu step
- ✅ Show greeting directly
- ✅ Show plant options immediately
- ✅ All messages in Marathi
- ✅ Proper error handling
- ✅ Full logging for debugging

---

## 📋 Complete Flow Test

```bash
# Step 1: Hi (shows greeting + plants)
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook -H "Content-Type: application/json" -d '{"eventType":"message","type":"text","text":"Hi","waId":"917588686453","senderName":"Vivek"}'

# Step 2: Select Plant (1 = Keli)
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook -H "Content-Type: application/json" -d '{"eventType":"message","type":"text","text":"1","waId":"917588686453","senderName":"Vivek"}'

# Step 3: Select Variety
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook -H "Content-Type: application/json" -d '{"eventType":"message","type":"text","text":"1","waId":"917588686453","senderName":"Vivek"}'

# Step 4: Select Cavity (2 = 100)
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook -H "Content-Type: application/json" -d '{"eventType":"message","type":"text","text":"2","waId":"917588686453","senderName":"Vivek"}'

# Step 5: Enter Quantity
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook -H "Content-Type: application/json" -d '{"eventType":"message","type":"text","text":"500","waId":"917588686453","senderName":"Vivek"}'

# Step 6: Select Delivery Date
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook -H "Content-Type: application/json" -d '{"eventType":"message","type":"text","text":"1","waId":"917588686453","senderName":"Vivek"}'

# Step 7: Confirm Order
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook -H "Content-Type: application/json" -d '{"eventType":"message","type":"text","text":"1","waId":"917588686453","senderName":"Vivek"}'
```

