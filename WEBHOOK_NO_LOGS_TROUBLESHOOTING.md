# 🔍 Webhook Not Showing Logs - Complete Troubleshooting Guide

## ✅ What We've Fixed

### 1. **Added Global Request Logger** (app.js)
- Logs ALL incoming requests to `/api/v1/whatsapp-order/webhook`
- Logs at the very beginning, before any middleware
- Shows: Method, Path, IP, User-Agent, Content-Type, Timestamp

### 2. **Added Route-Level Logger** (routes/whatsappOrderBot.route.js)
- Logs when the route handler is hit
- Confirms request reached the route

### 3. **Enhanced Controller Logger** (controllers/whatsappOrderBot.controller.js)
- Comprehensive RAW logging of:
  - Complete request info
  - All headers
  - Complete body (even if empty)
  - Query parameters

### 4. **Fixed Parameter Whitelisting** (middlewares/parameterWhiteListing.middleware.js)
- Added webhook endpoint to bypass list
- Prevents middleware from blocking webhook requests

### 5. **Added Test Endpoint** (routes/whatsappOrderBot.route.js)
- `/api/v1/whatsapp-order/webhook-test`
- Simple endpoint that immediately returns
- Use this to verify server is receiving requests

## 🚨 If You're Still Not Seeing Logs

### Step 1: Verify Server is Deployed

**CRITICAL:** The new logging code must be deployed to Render!

1. **Check if code is committed:**
   ```bash
   git status
   git add .
   git commit -m "Add comprehensive webhook logging"
   git push
   ```

2. **Check Render deployment:**
   - Go to: https://dashboard.render.com/
   - Select your service
   - Check "Events" tab for latest deployment
   - Verify deployment completed successfully

3. **Wait for deployment:**
   - Render deployments take 2-5 minutes
   - Wait until you see "Live" status

### Step 2: Test with Simple Endpoint

**Test the test endpoint:**
```bash
curl -X POST https://final-nursery-be-1.onrender.com/api/v1/whatsapp-order/webhook-test \
  -H "Content-Type: application/json" \
  -d '{"test":"data"}'
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Test endpoint working",
  "timestamp": "...",
  "body": {"test":"data"}
}
```

**Check Render Logs:**
You should see:
```
🧪🧪🧪 WEBHOOK TEST ENDPOINT HIT 🧪🧪🧪
```

**If you DON'T see logs:**
- Server not deployed with new code
- Check Render deployment status
- Verify git push was successful

### Step 3: Test Main Webhook Endpoint

**Test the webhook endpoint:**
```bash
curl -X POST https://final-nursery-be-1.onrender.com/api/v1/whatsapp-order/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "message",
    "data": {
      "waId": "919876543210",
      "text": {"body": "ORDER"}
    }
  }'
```

**Expected Response:**
```json
{"success":true}
```

**Check Render Logs:**
You should see ALL of these:
```
🌐🌐🌐 INCOMING REQUEST TO WEBHOOK 🌐🌐🌐
✅✅✅ WEBHOOK ROUTE HIT ✅✅✅
🔥🔥 RAW WATI WEBHOOK RECEIVED 🔥🔥
```

**If you DON'T see ANY logs:**
- Server not deployed
- Code not pushed to git
- Render deployment failed

### Step 4: Verify Wati Configuration

**If server logs work but Wati webhooks don't:**

1. **Check Wati Dashboard:**
   - Go to: https://app.wati.io/settings/webhooks
   - Verify webhook URL: `https://final-nursery-be-1.onrender.com/api/v1/whatsapp-order/webhook`
   - Check webhook status (should be "Active" or "Verified")

2. **Test Webhook from Wati:**
   - Click "Test Webhook" button in Wati dashboard
   - Immediately check Render logs
   - You should see the log markers

3. **Check Wati Status:**
   - Go to: https://status.wati.io/
   - Verify all services are operational

4. **Verify Events:**
   - In Wati dashboard, ensure these events are subscribed:
     - ✅ `message`
     - ✅ `message_received`
     - ✅ `button_reply` (if using buttons)

### Step 5: Check Render Logs Properly

**How to view logs correctly:**

1. **Go to Render Dashboard:**
   - https://dashboard.render.com/
   - Select your service: `final-nursery-be-1`

2. **Click "Logs" tab**

3. **Filter logs:**
   - Look for these markers:
     - `🌐🌐🌐 INCOMING REQUEST`
     - `✅✅✅ WEBHOOK ROUTE HIT`
     - `🔥🔥 RAW WATI WEBHOOK`

4. **Real-time logs:**
   - Logs update in real-time
   - Send test request and watch logs immediately

5. **Check log level:**
   - Make sure you're viewing "All Logs" not just "Errors"

### Step 6: Verify No Middleware Blocking

**Check these in app.js:**

1. **IP Whitelisting:**
   ```javascript
   // Should be commented out:
   // server.use(IPWhiteListing);
   ```

2. **Parameter Whitelisting:**
   - Webhook should be in bypass list (already fixed)

3. **Auth Middleware:**
   - Webhook should be in public paths (already fixed)

4. **Route Order:**
   - Webhook route should be BEFORE protected routes (already correct)

## 🔍 Debugging Checklist

- [ ] Code committed and pushed to git
- [ ] Render deployment completed successfully
- [ ] Server status is "Live" in Render
- [ ] Test endpoint (`/webhook-test`) shows logs
- [ ] Main webhook endpoint (`/webhook`) shows logs when tested with curl
- [ ] Wati webhook URL configured correctly
- [ ] Wati webhook status is "Active"
- [ ] Events subscribed in Wati: `message`, `message_received`
- [ ] Tested webhook from Wati dashboard
- [ ] Render logs are set to "All Logs" not just "Errors"
- [ ] Checked logs immediately after sending test

## 🚨 Most Common Issues

### Issue 1: "No logs at all"
**Cause:** Server not deployed with new code
**Solution:** 
- Commit and push code
- Wait for Render deployment
- Verify deployment succeeded

### Issue 2: "Test endpoint works, but Wati doesn't"
**Cause:** Wati not configured or not sending webhooks
**Solution:**
- Check Wati dashboard configuration
- Verify webhook URL is correct
- Test webhook from Wati dashboard
- Check Wati status page

### Issue 3: "Logs appear but body is empty"
**Cause:** Wati sending data in different format
**Solution:**
- Check RAW log for headers
- Verify Content-Type header
- Check if data is in query params instead of body

### Issue 4: "401 Unauthorized"
**Cause:** Auth middleware blocking (should be fixed)
**Solution:**
- Verify webhook is in public paths
- Check auth middleware logs for "Public endpoint accessed"

## 📋 Next Steps

1. **Commit and push all changes:**
   ```bash
   git add .
   git commit -m "Add comprehensive webhook logging and fixes"
   git push
   ```

2. **Wait for Render deployment** (2-5 minutes)

3. **Test test endpoint:**
   ```bash
   curl -X POST https://final-nursery-be-1.onrender.com/api/v1/whatsapp-order/webhook-test \
     -H "Content-Type: application/json" \
     -d '{"test":"data"}'
   ```

4. **Check Render logs** - should see test endpoint logs

5. **Test main webhook:**
   ```bash
   curl -X POST https://final-nursery-be-1.onrender.com/api/v1/whatsapp-order/webhook \
     -H "Content-Type: application/json" \
     -d '{"event":"message","data":{"waId":"919876543210","text":{"body":"ORDER"}}}'
   ```

6. **Check Render logs** - should see all log markers

7. **Configure Wati webhook** if not done already

8. **Test from Wati dashboard** - click "Test Webhook"

9. **Check Render logs** - should see Wati webhook logs

## 🔗 Important Links

- **Render Dashboard:** https://dashboard.render.com/
- **Wati Dashboard:** https://app.wati.io/settings/webhooks
- **Wati Status:** https://status.wati.io/
- **Webhook URL:** https://final-nursery-be-1.onrender.com/api/v1/whatsapp-order/webhook

## 💡 Key Points

1. **Logs are added at 3 levels:**
   - Global (app.js) - catches ALL requests
   - Route (routes) - confirms route is hit
   - Controller (controller) - detailed payload logging

2. **If NO logs appear:**
   - Server not deployed with new code
   - Check Render deployment status
   - Verify git push was successful

3. **If logs appear for curl but not Wati:**
   - Wati not configured correctly
   - Check Wati dashboard
   - Verify webhook URL and events

4. **Always check Render logs immediately** after:
   - Testing endpoint
   - Sending test from Wati
   - Sending WhatsApp message


