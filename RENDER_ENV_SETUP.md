# 🔧 Render Environment Variables Setup

## Required Environment Variables for WhatsApp Bot

Set these in your Render dashboard under **Environment** section:

### ✅ **CRITICAL - Must Set:**

1. **`WATI_TOKEN`** (Required)
   - Your WATI API token
   - Get it from: https://app.wati.io/ → Settings → API
   - Value: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIwNjY4YWY5Zi1jN2I1LTQ2N2QtOWU0Yi01ZjRjOTJhNThlZjMiLCJ1bmlxdWVfbmFtZSI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwibmFtZWlkIjoidml2ZWtjLmFwa0BnbWFpbC5jb20iLCJlbWFpbCI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwiYXV0aF90aW1lIjoiMDkvMjEvMjAyNSAwNDo1ODozMiIsInRlbmFudF9pZCI6IjM4NTQwMyIsImRiX25hbWUiOiJtdC1wcm9kLVRlbmFudHMiLCJodHRwOi8vc2NoZW1hcy5taWNyb3NvZnQuY29tL3dzLzIwMDgvMDYvaWRlbnRpdHkvY2xhaW1zL3JvbGUiOiJBRE1JTklTVFJBVE9SIiwiZXhwIjoyNTM0MDIzMDA4MDAsImlzcyI6IkNsYXJlX0FJIiwiYXVkIjoiQ2xhcmVfQUkifQ.zAP3ZxQXUO1NWJGLe0e39qVeiXLK_d8U2y0bonMjomw`
   - ⚠️ **Without this, messages won't be sent!**

### ⚙️ **OPTIONAL - Has Defaults:**

2. **`WATI_URL`** (Optional)
   - WATI API base URL
   - Default: `https://live-mt-server.wati.io/385403`
   - Only set if you need a different URL
   - Must start with `http://` or `https://`

3. **`ADMIN_PHONE`** (Optional)
   - Phone number to receive order notifications
   - Default: `7588686452`
   - Format: Just the number (e.g., `7588686452` or `917588686452`)

4. **`API_BASE_URL`** (Optional)
   - Internal API base URL for order creation
   - Default: `http://localhost:8000`
   - For production, set to: `https://final-nursery-be-1.onrender.com`

## 📋 How to Set on Render:

1. Go to your Render dashboard
2. Select your service (`final-nursery-be-1`)
3. Click **Environment** tab
4. Click **Add Environment Variable**
5. Add each variable:
   - **Key**: `WATI_TOKEN`
   - **Value**: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` (your full token)
6. Click **Save Changes**
7. **Redeploy** your service (Render will auto-redeploy)

## ✅ Verify Configuration:

After setting variables, check the diagnostics endpoint:

```bash
curl https://final-nursery-be-1.onrender.com/api/v1/whatsapp-order/diagnostics
```

This will show:
- ✅ Which variables are set
- ✅ Token expiration status
- ✅ Current configuration values

## 🔍 Check Logs:

After deployment, check Render logs for:

```
🔧 [INIT] WhatsApp Order Bot Configuration
   WATI_TOKEN from env: ✅ YES
   WATI_URL from env: ✅ YES
```

If you see `❌ NO (using default)`, the environment variable is not set correctly.

## 🚨 Common Issues:

1. **Messages not sending?**
   - Check `WATI_TOKEN` is set correctly
   - Verify token hasn't expired (check diagnostics endpoint)

2. **401 Unauthorized?**
   - Token might be expired
   - Get new token from WATI dashboard
   - Update `WATI_TOKEN` in Render

3. **Webhook not receiving?**
   - Check webhook URL in WATI: `https://final-nursery-be-1.onrender.com/api/v1/whatsapp-order/webhook`
   - Verify Render service is running

## 📝 Quick Checklist:

- [ ] `WATI_TOKEN` is set in Render
- [ ] Service redeployed after setting variables
- [ ] Diagnostics endpoint shows `✅ YES` for token
- [ ] Webhook URL configured in WATI dashboard
- [ ] Test message sent successfully

