# 🔧 WATI "message text can not be empty" Error - Fix Guide

## ❌ Error You're Seeing

```json
{
  "result": false,
  "info": "message text can not be empty"
}
```

## 🔍 Root Cause

The `sendSessionMessage` endpoint **REQUIRES an active session**. This means:

1. **The recipient must have messaged your WATI number FIRST**
2. **The session is active for 24 hours** after the last message
3. **If no active session exists**, the API returns this error (even though you're sending text)

## ✅ Solutions

### Solution 1: Create Active Session (Recommended)

**Step 1:** Have the phone number (`917588686453`) send a WhatsApp message to your WATI number first.

**Step 2:** Wait a few seconds for the session to be established.

**Step 3:** Then try your curl command again.

### Solution 2: Use Template Message Instead

If you don't have an active session, use `sendTemplateMessage` instead:

```bash
curl -X POST "https://live-mt-server.wati.io/385403/api/v1/sendTemplateMessage?whatsappNumber=917588686453" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIwNjY4YWY5Zi1jN2I1LTQ2N2QtOWU0Yi01ZjRjOTJhNThlZjMiLCJ1bmlxdWVfbmFtZSI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwibmFtZWlkIjoidml2ZWtjLmFwa0BnbWFpbC5jb20iLCJlbWFpbCI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwiYXV0aF90aW1lIjoiMDkvMjEvMjAyNSAwNDo1ODozMiIsInRlbmFudF9pZCI6IjM4NTQwMyIsImRiX25hbWUiOiJtdC1wcm9kLVRlbmFudHMiLCJodHRwOi8vc2NoZW1hcy5taWNyb3NvZnQuY29tL3dzLzIwMDgvMDYvaWRlbnRpdHkvY2xhaW1zL3JvbGUiOiJBRE1JTklTVFJBVE9SIiwiZXhwIjoyNTM0MDIzMDA4MDAsImlzcyI6IkNsYXJlX0FJIiwiYXVkIjoiQ2xhcmVfQUkifQ.zAP3ZxQXUO1NWJGLe0e39qVeiXLK_d8U2y0bonMjomw" \
  -d '{
    "template_name": "your_template_name",
    "broadcast_name": "test_broadcast",
    "parameters": []
  }'
```

**Note:** Template messages don't require active sessions, but you need an approved template.

### Solution 3: Check Session Status

You can check if a session exists using the WATI API (if available in your plan).

## 📋 Quick Test Steps

1. **Send a message FROM `917588686453` TO your WATI number**
   - This creates the active session
   
2. **Wait 5-10 seconds**

3. **Run your curl command again:**

```bash
curl -X POST "https://live-mt-server.wati.io/385403/api/v1/sendSessionMessage/917588686453" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIwNjY4YWY5Zi1jN2I1LTQ2N2QtOWU0Yi01ZjRjOTJhNThlZjMiLCJ1bmlxdWVfbmFtZSI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwibmFtZWlkIjoidml2ZWtjLmFwa0BnbWFpbC5jb20iLCJlbWFpbCI6InZpdmVrYy5hcGtAZ21haWwuY29tIiwiYXV0aF90aW1lIjoiMDkvMjEvMjAyNSAwNDo1ODozMiIsInRlbmFudF9pZCI6IjM4NTQwMyIsImRiX25hbWUiOiJtdC1wcm9kLVRlbmFudHMiLCJodHRwOi8vc2NoZW1hcy5taWNyb3NvZnQuY29tL3dzLzIwMDgvMDYvaWRlbnRpdHkvY2xhaW1zL3JvbGUiOiJBRE1JTklTVFJBVE9SIiwiZXhwIjoyNTM0MDIzMDA4MDAsImlzcyI6IkNsYXJlX0FJIiwiYXVkIjoiQ2xhcmVfQUkifQ.zAP3ZxQXUO1NWJGLe0e39qVeiXLK_d8U2y0bonMjomw" \
  -d '{"text":"✅ Test after creating session"}'
```

## 🎯 For Webhook Use Case

Since you're using this in a webhook handler:

1. **When a user messages your WATI number** → Webhook receives it
2. **Session is automatically created** → You can reply using `sendSessionMessage`
3. **Session lasts 24 hours** → You can send messages during this window

This is perfect for your WhatsApp order bot! The webhook will receive messages, and you can reply using `sendSessionMessage`.

## 💡 Summary

- ✅ **Error is NOT about the field name** - all field names return the same error
- ✅ **Error IS about missing active session** - phone must message WATI first
- ✅ **For webhooks, this works perfectly** - user messages create the session automatically
- ✅ **For testing, send a message first** - then test the curl command


