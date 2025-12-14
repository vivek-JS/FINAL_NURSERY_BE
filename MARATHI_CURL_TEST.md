# 🇮🇳 Marathi WhatsApp Bot - cURL Test Commands

## 🧪 Test Commands

### Test 1: Start Conversation (Hi/नमस्कार)

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

**Bot Response (Marathi):**
```
नमस्कार भाऊ!! 👋

🌱 Nursery Order System मध्ये आपले स्वागत आहे!

कृपया एक पर्याय निवडा:

1️⃣ नवीन ऑर्डर
2️⃣ माझ्या ऑर्डर
3️⃣ मदत
```

---

### Test 2: Start New Order (Option 1)

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

**Bot Response:**
```
🌱 आपल्याला कोणती रोप बुक करायची आहे?

1️⃣ Keli (केळी)
2️⃣ Papaya (पपया)
3️⃣ Tarbooj (तरबूज)
4️⃣ Kharbooj (खरबूज)

नंबर टाइप करा
```

---

### Test 3: Select Plant (Keli - Option 1)

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

**Bot Response:**
```
✅ रोप निवडली: Keli

विविधता लोड होत आहे...
```

Then immediately:
```
🍃 Keli च्या विविधता:

1️⃣ Grand Naine – ₹5
2️⃣ Robusta – ₹6

विविधता निवडा
```

---

### Test 4: Select Variety (Option 1)

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

**Bot Response:**
```
✅ विविधता: Grand Naine
दर: ₹5

📦 ट्रे कॅविटी निवडा:

1️⃣ 50
2️⃣ 100
3️⃣ 200
```

---

### Test 5: Select Cavity (Option 2 - 100)

```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "message",
    "type": "text",
    "text": "2",
    "waId": "917588686453",
    "senderName": "Vivek"
  }'
```

**Bot Response:**
```
✅ कॅविटी: 100

🔢 प्रमाण टाइप करा (फक्त नंबर)

उदाहरण: 500
```

---

### Test 6: Enter Quantity (500)

```bash
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "message",
    "type": "text",
    "text": "500",
    "waId": "917588686453",
    "senderName": "Vivek"
  }'
```

**Bot Response:**
```
✅ प्रमाण: 500

उपलब्ध डिलिव्हरी तारखा लोड होत आहेत...
```

Then:
```
📅 डिलिव्हरी आठवडा निवडा:

1️⃣ 1-7 Jan (उपलब्ध: 3000)
2️⃣ 8-14 Jan (उपलब्ध: 2500)
```

---

### Test 7: Select Delivery Date (Option 1)

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

**Bot Response:**
```
📋 *ऑर्डर सारांश*

🌱 रोप: Keli
🍃 विविधता: Grand Naine
📦 कॅविटी: 100
🔢 प्रमाण: 500
💰 दर: ₹5
💵 एकूण: ₹2500
📅 डिलिव्हरी: 1-7 Jan

उत्तर द्या:
1️⃣ ऑर्डर पुष्टी करा
2️⃣ रद्द करा
```

---

### Test 8: Confirm Order (Option 1)

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

**Bot Response:**
```
⏳ आपली ऑर्डर प्रक्रिया करत आहे... कृपया प्रतीक्षा करा.
```

Then:
```
✅ *ऑर्डर यशस्वीरित्या झाली!*

🧾 ऑर्डर ID: 12345
📅 डिलिव्हरी: 1-7 Jan

धन्यवाद 🙏

दुसरी ऑर्डर करण्यासाठी HI टाइप करा
```

---

## 🎯 Complete Flow Test (One by One)

```bash
# Step 1: Hi
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"Hi","waId":"917588686453","senderName":"Vivek"}'

# Step 2: New Order
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"1","waId":"917588686453","senderName":"Vivek"}'

# Step 3: Select Plant (Keli)
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"1","waId":"917588686453","senderName":"Vivek"}'

# Step 4: Select Variety
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"1","waId":"917588686453","senderName":"Vivek"}'

# Step 5: Select Cavity (100)
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"2","waId":"917588686453","senderName":"Vivek"}'

# Step 6: Enter Quantity
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"500","waId":"917588686453","senderName":"Vivek"}'

# Step 7: Select Date
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"1","waId":"917588686453","senderName":"Vivek"}'

# Step 8: Confirm
curl -X POST http://localhost:8000/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventType":"message","type":"text","text":"1","waId":"917588686453","senderName":"Vivek"}'
```

---

## 📝 Key Marathi Messages

- **Greeting:** "नमस्कार भाऊ!! 👋"
- **Plant Selection:** "आपल्याला कोणती रोप बुक करायची आहे?"
- **Variety:** "च्या विविधता:"
- **Cavity:** "ट्रे कॅविटी निवडा"
- **Quantity:** "प्रमाण टाइप करा (फक्त नंबर)"
- **Delivery:** "डिलिव्हरी आठवडा निवडा"
- **Summary:** "ऑर्डर सारांश"
- **Success:** "ऑर्डर यशस्वीरित्या झाली!"

---

## ✅ All Messages Now in Marathi!

The bot now communicates entirely in Marathi, making it farmer-friendly! 🌾

