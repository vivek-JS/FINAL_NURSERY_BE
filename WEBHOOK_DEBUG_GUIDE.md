# 🔍 WhatsApp Webhook Debugging Guide

## ✅ What We've Added

### 1. **Enhanced RAW Logger** (in controller)
- Logs complete request info (method, URL, IP, timestamp)
- Logs ALL headers from Wati
- Logs complete request body (even if empty)
- Logs query parameters
- Works in ALL environments (production + development)

### 2. **Route-Level Logger** (in routes)
- Catches requests BEFORE they reach the controller
- Confirms the route is being hit
- Logs basic request info

## 🔍 How to Debug

### Step 1: Check if Webhook is Configured in Wati

1. **Go to Wati Dashboard:**
   - https://app.wati.io/settings/webhooks
   - Login with your Wati account

2. **Verify Webhook URL:**
   ```
   https://final-nursery-be-1.onrender.com/api/v1/whatsapp-order/webhook
   ```

3. **Check Events Subscribed:**
   - ✅ `message` (required)
   - ✅ `message_received` (optional but recommended)
   - ✅ `button_reply` (if using buttons)

4. **Test Webhook in Dashboard:**
   - Click "Test Webhook" button in Wati dashboard
   - Check your Render logs immediately

### Step 2: Check Render Logs

1. **Go to Render Dashboard:**
   - https://dashboard.render.com/
   - Select your service: `final-nursery-be-1`
   - Click "Logs" tab

2. **Look for these log markers:**
   ```
   ✅✅✅ WEBHOOK ROUTE HIT ✅✅✅
   🔥🔥 RAW WATI WEBHOOK RECEIVED 🔥🔥
   ```

3. **If you see these logs:**
   - ✅ Webhook is working!
   - Check the body content to see what Wati sent

4. **If you DON'T see these logs:**
   - ❌ Webhook is not reaching your server
   - Check Wati configuration
   - Check if server is running

### Step 3: Test Manually

**Test with cURL:**
```bash
curl -X POST https://final-nursery-be-1.onrender.com/api/v1/whatsapp-order/webhook \
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
{"success":true}
```

**Check Render Logs After:**
You should see:
```
✅✅✅ WEBHOOK ROUTE HIT ✅✅✅
🔥🔥 RAW WATI WEBHOOK RECEIVED 🔥🔥
```

### Step 4: Test with Real WhatsApp Message

1. **Send WhatsApp message to your Wati number:**
   - Text: `ORDER`
   - Or any message

2. **Immediately check Render logs:**
   - Look for the log markers
   - Check the RAW webhook log for complete payload

3. **If logs appear:**
   - ✅ Webhook is working!
   - Check the payload structure

4. **If logs DON'T appear:**
   - Check Wati webhook configuration
   - Verify webhook URL is correct
   - Check if Wati account has credits
   - Verify Wati number is active

## 🚨 Common Issues

### Issue 1: No Logs Appearing

**Possible Causes:**
- Webhook not configured in Wati dashboard
- Wrong webhook URL in Wati
- Server not deployed/redeployed
- Wati not sending webhooks (check Wati status)

**Solution:**
1. Verify webhook URL in Wati: `https://final-nursery-be-1.onrender.com/api/v1/whatsapp-order/webhook`
2. Click "Test Webhook" in Wati dashboard
3. Check Render logs immediately

### Issue 2: Logs Show Empty Body

**Possible Causes:**
- Wati sending data in different format
- Content-Type header issue
- Body parser not working

**Solution:**
- Check the RAW log for headers
- Verify `Content-Type: application/json` in headers
- Check if body is in query params instead

### Issue 3: 401 Unauthorized

**Possible Causes:**
- Auth middleware blocking request
- Route not in public paths

**Solution:**
- Already fixed - webhook is in public paths
- Check auth middleware logs for "Public endpoint accessed"

### Issue 4: 404 Not Found

**Possible Causes:**
- Wrong URL
- Route not registered
- Server not running

**Solution:**
- Verify URL: `/api/v1/whatsapp-order/webhook`
- Check app.js has route registered
- Verify server is running

## 📋 Checklist

- [ ] Webhook URL configured in Wati dashboard
- [ ] Events subscribed: `message`, `message_received`
- [ ] Server deployed/redeployed with new logging
- [ ] Test webhook from Wati dashboard
- [ ] Check Render logs for log markers
- [ ] Send test WhatsApp message
- [ ] Verify logs appear in Render

## 🔗 Important Links

- **Wati Dashboard:** https://app.wati.io/settings/webhooks
- **Render Dashboard:** https://dashboard.render.com/
- **Webhook URL:** https://final-nursery-be-1.onrender.com/api/v1/whatsapp-order/webhook
- **Wati Status:** https://status.wati.io/

## 📞 Next Steps

1. **Redeploy your application** to Render (if you haven't already)
2. **Configure webhook in Wati dashboard** with the URL above
3. **Test webhook** from Wati dashboard
4. **Check Render logs** for the log markers
5. **Send test WhatsApp message** and check logs again

If logs still don't appear after all these steps, the issue is likely:
- Wati not configured correctly
- Wati not sending webhooks
- Network/firewall blocking Wati requests


