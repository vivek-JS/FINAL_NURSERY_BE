# Testing Ram Agri Video Summary API

## Quick Test

Use this curl command to test the API:

```bash
curl 'http://localhost:8000/api/v1/inventory/ram-agri-video-summary?period=day' \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN' \
  -H 'Content-Type: application/json'
```

Or test for week:
```bash
curl 'http://localhost:8000/api/v1/inventory/ram-agri-video-summary?period=week' \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN' \
  -H 'Content-Type: application/json'
```

## Using the Test Script

1. Make sure your server is running
2. Get a JWT token from login
3. Run the test script:

```bash
cd FINAL_NURSERY_BE
node test-video-summary.js YOUR_JWT_TOKEN day
```

Or for week:
```bash
node test-video-summary.js YOUR_JWT_TOKEN week
```

## Expected Response

### Success Response:
```json
{
  "status": "Success",
  "message": "Ram Agri video summary generated successfully",
  "data": {
    "period": "day",
    "currentPeriod": {
      "start": "2026-01-26T00:00:00.000Z",
      "end": "2026-01-26T23:59:59.999Z",
      "totalOrders": 45,
      "dispatchedOrders": 32,
      "totalSales": 125000,
      "topSalesman": {
        "name": "John Doe",
        "sales": 45000,
        "orders": 12
      }
    },
    "previousPeriod": {
      "start": "2026-01-25T00:00:00.000Z",
      "end": "2026-01-25T23:59:59.999Z",
      "totalOrders": 38,
      "dispatchedOrders": 28,
      "totalSales": 110000
    },
    "comparison": {
      "orderChange": 7,
      "orderChangePercent": "18.4",
      "dispatchedChange": 4,
      "salesChange": 15000,
      "salesChangePercent": "13.6"
    },
    "hindiSummary": "नमस्ते! आज की राम एग्री सेल्स रिपोर्ट...",
    "video": {
      "videoUrl": "https://d-id.com/video/...",
      "talkId": "abc123"
    },
    "videoError": null
  }
}
```

### If D_ID_API_KEY not configured:
```json
{
  "video": null,
  "videoError": "D_ID_API_KEY not configured in environment variables"
}
```

### If D_ID_API_KEY is invalid:
```json
{
  "video": null,
  "videoError": "D-ID API authentication failed. Please check your D_ID_API_KEY in .env file."
}
```

## Troubleshooting

### 1. "Invalid parameters: period" error
- ✅ Fixed: Added "period" to parameter whitelist

### 2. "D_ID_API_KEY not configured" 
- Check `.env` file has `D_ID_API_KEY=your_key`
- Restart server after adding to `.env`

### 3. "D-ID API authentication failed"
- Verify API key format: should be `email:api_key` or just `api_key`
- Check API key is valid at https://studio.d-id.com/

### 4. Video generation takes too long
- Normal: D-ID API can take 10-30 seconds
- Maximum wait: 5 minutes (60 attempts × 5 seconds)

### 5. No video but text summary works
- This is expected if D_ID_API_KEY is not set
- Text summary will always be available
- Video is optional enhancement

## Frontend Test

1. Open Ram Agri Sales Dashboard
2. Click "Video (Day)" or "Video (Week)" button
3. Check the modal shows:
   - Video player (if video generated)
   - Hindi text summary
   - Comparison statistics
   - Top salesman info
