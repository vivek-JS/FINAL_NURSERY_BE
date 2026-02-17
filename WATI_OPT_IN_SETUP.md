# Wati Opt-In/Opt-Out Webhook Setup Guide

## Important Note

Based on Wati's webhook structure, **Wati may not send explicit `opt_in` and `opt_out` webhook events**. Instead, opt-in/opt-out status is typically managed through:

1. **Contact subscription status** (via API)
2. **Contact update events** (if available)
3. **Manual tracking** through user interactions

## Current Situation

Your webhook is currently receiving **message events** (`eventType: "message"`), not opt-in/opt-out events. This is expected behavior.

## Solution Options

### Option 1: Use Contact Subscription Status API (Recommended)

Instead of webhooks, check opt-in status via Wati's Contact API:

```javascript
// Check contact subscription status
GET https://live-mt-server.wati.io/385403/api/v1/getContacts/{waId}
Authorization: Bearer {TOKEN}
```

The response will include subscription status.

### Option 2: Track Opt-In Manually

Track opt-in/opt-out through user interactions:

1. **When user sends "START" or "YES"** → Set `opt_in: true`
2. **When user sends "STOP" or "NO"** → Set `opt_in: false`
3. **Update via your WhatsApp bot** when users explicitly opt-in/opt-out

### Option 3: Use Contact Update Webhooks (If Available)

If Wati supports contact update webhooks, configure them to track subscription changes.

## Current Webhook Behavior

The opt-in webhook endpoint will:
- ✅ Accept webhook requests from Wati
- ✅ Ignore message events (return success)
- ✅ Process `opt_in` and `opt_out` events if Wati sends them
- ✅ Log all requests for debugging

## Testing

Even though Wati may not send opt_in/opt_out events directly, you can test the endpoint:

```bash
# Test with opt_in event (if Wati supports it)
curl -X POST https://api1.rambiotechplants.com/api/v1/opt-in/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "opt_in",
    "waId": "917588686453"
  }'
```

## Recommended Implementation

Since Wati may not send explicit opt-in/opt-out webhooks, consider:

1. **Track opt-in through your WhatsApp bot** - When users interact, update their status
2. **Use Wati Contact API** - Periodically check subscription status
3. **Manual opt-in/opt-out commands** - Let users send commands like "START" or "STOP"

## Next Steps

1. Check Wati documentation for contact subscription webhooks
2. Implement opt-in tracking in your WhatsApp bot
3. Use the Contact API to verify subscription status
