#!/bin/bash

# 🧪 WhatsApp Order Bot - Webhook Testing Script
# This script simulates WATI webhook requests to test the bot locally

BASE_URL="http://localhost:8000"
WEBHOOK_ENDPOINT="/api/v1/whatsapp-order/webhook"

echo "🧪 Testing WhatsApp Order Bot Webhook"
echo "======================================"
echo ""

# Test 1: Format 1 - New format (eventType, type, text, waId, senderName)
echo "📋 Test 1: Format 1 - New Format (Hi message)"
echo "----------------------------------------------"
curl -X POST "${BASE_URL}${WEBHOOK_ENDPOINT}" \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "message",
    "type": "text",
    "text": "Hi",
    "waId": "917588686453",
    "senderName": "Vivek"
  }'
echo ""
echo ""

# Test 2: Format 2 - Direct format (text, waId)
echo "📋 Test 2: Format 2 - Direct Format (Hello message)"
echo "----------------------------------------------------"
curl -X POST "${BASE_URL}${WEBHOOK_ENDPOINT}" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello",
    "waId": "917588686453"
  }'
echo ""
echo ""

# Test 3: Format 3 - Nested Wati format (event, data)
echo "📋 Test 3: Format 3 - Nested Format (ORDER message)"
echo "---------------------------------------------------"
curl -X POST "${BASE_URL}${WEBHOOK_ENDPOINT}" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "message",
    "data": {
      "waId": "917588686453",
      "text": {
        "body": "1"
      },
      "from": "917588686453"
    }
  }'
echo ""
echo ""

# Test 4: Format 4 - Simple nested (data.text, data.waId)
echo "📋 Test 4: Format 4 - Simple Nested (Start message)"
echo "-----------------------------------------------------"
curl -X POST "${BASE_URL}${WEBHOOK_ENDPOINT}" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "text": "start",
      "waId": "917588686453"
    }
  }'
echo ""
echo ""

# Test 5: Plant Selection (Step 2)
echo "📋 Test 5: Plant Selection (Selecting plant 1)"
echo "------------------------------------------------"
curl -X POST "${BASE_URL}${WEBHOOK_ENDPOINT}" \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "message",
    "type": "text",
    "text": "1",
    "waId": "917588686453",
    "senderName": "Vivek"
  }'
echo ""
echo ""

# Test 6: Variety Selection (Step 3)
echo "📋 Test 6: Variety Selection (Selecting variety 1)"
echo "----------------------------------------------------"
curl -X POST "${BASE_URL}${WEBHOOK_ENDPOINT}" \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "message",
    "type": "text",
    "text": "1",
    "waId": "917588686453",
    "senderName": "Vivek"
  }'
echo ""
echo ""

# Test 7: Cancel Command
echo "📋 Test 7: Cancel Command"
echo "--------------------------"
curl -X POST "${BASE_URL}${WEBHOOK_ENDPOINT}" \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "message",
    "type": "text",
    "text": "cancel",
    "waId": "917588686453",
    "senderName": "Vivek"
  }'
echo ""
echo ""

# Test 8: Help Command
echo "📋 Test 8: Help Command"
echo "------------------------"
curl -X POST "${BASE_URL}${WEBHOOK_ENDPOINT}" \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "message",
    "type": "text",
    "text": "help",
    "waId": "917588686453",
    "senderName": "Vivek"
  }'
echo ""
echo ""

echo "✅ All tests completed!"
echo ""
echo "📝 Note: Check your server logs to see:"
echo "   1. What webhook was received"
echo "   2. What message was sent back via WATI API"
echo "   3. The full URL that was called to send the message"
echo ""

