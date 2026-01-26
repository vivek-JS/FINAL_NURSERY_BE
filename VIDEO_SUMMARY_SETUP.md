# Ram Agri Video Summary Setup Guide

## Overview
This feature generates short Hindi video summaries (20-30 seconds) comparing sales performance between periods (day vs day, week vs week). The videos include:
- Total orders comparison
- Dispatched orders comparison
- Sales value comparison
- Top performing salesman
- All important metrics

## API Endpoint
```
GET /api/v1/inventory/ram-agri-video-summary?period=day|week
```

## Setup Instructions

### 1. D-ID API Setup (Recommended)
D-ID provides AI-powered video generation with talking avatars.

1. Sign up at https://www.d-id.com/
2. Get your API key from the dashboard
3. Add to `.env` file:
   ```
   D_ID_API_KEY=your_d_id_api_key_here
   ```

**Note:** D-ID has a free tier with limited credits. For production, consider upgrading.

### 2. Alternative: Google Cloud Text-to-Speech + FFmpeg
If you prefer not to use D-ID, you can use Google Cloud TTS:

1. Set up Google Cloud TTS:
   ```bash
   npm install @google-cloud/text-to-speech
   ```

2. Add to `.env`:
   ```
   GOOGLE_CLOUD_PROJECT_ID=your_project_id
   GOOGLE_APPLICATION_CREDENTIALS=path/to/credentials.json
   ```

3. Install FFmpeg (for video creation):
   ```bash
   # macOS
   brew install ffmpeg
   
   # Ubuntu/Debian
   sudo apt-get install ffmpeg
   ```

## Usage

### Frontend
Click the "Video (Day)" or "Video (Week)" buttons in the Ram Agri Sales Dashboard header.

### API Call Example
```javascript
const response = await fetch('/api/v1/inventory/ram-agri-video-summary?period=day', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const data = await response.json();
// data.video.videoUrl contains the video URL
// data.hindiSummary contains the Hindi text summary
```

## Response Format
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
    }
  }
}
```

## Features

### Hindi Text Generation
- Automatically generates Hindi summary text
- Includes comparisons with previous period
- Highlights top performers
- Uses Indian number formatting

### Video Generation
- Uses D-ID API for professional video generation
- Hindi voice: `hi-IN-SwaraNeural` (Microsoft TTS)
- Default avatar (can be customized)
- 20-30 second duration

### Period Comparison
- **Day**: Compares today vs yesterday
- **Week**: Compares this week (Mon-Sun) vs last week

## Troubleshooting

### Video not generating
1. Check if `D_ID_API_KEY` is set in `.env`
2. Verify API key is valid and has credits
3. Check backend logs for errors

### Audio/Video quality issues
- D-ID free tier has limitations
- Consider upgrading for better quality
- Check network connectivity

### Hindi text not displaying correctly
- Ensure browser supports UTF-8
- Check font rendering in frontend

## Future Enhancements
- [ ] Custom avatar selection
- [ ] Multiple language support
- [ ] Video download functionality
- [ ] Scheduled video generation
- [ ] Email/SMS video sharing
- [ ] Custom video templates
