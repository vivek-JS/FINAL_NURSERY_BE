# 🆓 Complete Google Cloud TTS Setup Guide

## ✅ Implementation Status

The FREE Google Cloud TTS + FFmpeg video generation is **fully implemented** and ready to use!

---

## 📋 Step-by-Step: Generate Google Cloud TTS API Key

### Step 1: Go to Google Cloud Console

1. Open your browser
2. Go to: **https://console.cloud.google.com/**
3. Sign in with your Google account (Gmail)

### Step 2: Create a Project

1. Click the **project dropdown** at the top (shows current project name)
2. Click **"New Project"** button
3. Enter project name: `Ram Agri Video` (or any name you like)
4. Click **"Create"**
5. Wait 10-20 seconds for project creation
6. **Select the new project** from the dropdown (important!)

### Step 3: Enable Text-to-Speech API

1. In the left sidebar, click **"APIs & Services"**
2. Click **"Library"** (or go directly to: https://console.cloud.google.com/apis/library)
3. In the search bar, type: **"Text-to-Speech"**
4. Click on **"Cloud Text-to-Speech API"**
5. Click the big blue **"Enable"** button
6. Wait 5-10 seconds for activation
7. You'll see "API enabled" confirmation

### Step 4: Create API Key

1. In the left sidebar, go to **"APIs & Services"** > **"Credentials"**
   - Or go directly to: https://console.cloud.google.com/apis/credentials
2. Click **"+ CREATE CREDENTIALS"** button at the top
3. Select **"API key"** from the dropdown
4. **Your API key will appear immediately!**
   - It looks like: `AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz1234567`
5. **⚠️ IMPORTANT**: Copy this key NOW - you might not see it again!
6. Click **"Close"** (don't restrict it yet, we'll do that next)

### Step 5: (Optional but Recommended) Restrict API Key

1. In the Credentials page, find your newly created API key
2. Click on the API key name (or click the edit/pencil icon)
3. Under **"API restrictions"**:
   - Select **"Restrict key"**
   - Check **"Cloud Text-to-Speech API"** only
   - Click **"Save"**
4. Under **"Application restrictions"** (optional):
   - For development: Select **"None"** (or restrict by IP if you have a static IP)
   - For production: Restrict by HTTP referrer or IP
   - Click **"Save"**

### Step 6: Add to .env File

1. Open your backend `.env` file:
   ```bash
   cd FINAL_NURSERY_BE
   nano .env
   # or use your preferred editor
   ```

2. Add this line:
   ```bash
   GOOGLE_TTS_API_KEY=AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz1234567
   ```
   (Replace with your actual API key from Step 4)

3. Save the file (Ctrl+X, then Y, then Enter for nano)

### Step 7: Install FFmpeg

**macOS:**
```bash
brew install ffmpeg
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get update
sudo apt-get install ffmpeg
```

**Windows:**
1. Download from: https://ffmpeg.org/download.html
2. Extract to a folder (e.g., `C:\ffmpeg`)
3. Add to PATH:
   - Right-click "This PC" > Properties > Advanced System Settings
   - Environment Variables > System Variables > Path > Edit
   - Add: `C:\ffmpeg\bin`

**Verify installation:**
```bash
ffmpeg -version
```
You should see version information.

### Step 8: Restart Your Server

```bash
# Stop your server (Ctrl+C if running)
cd FINAL_NURSERY_BE
npm start
# or
npm run dev
```

---

## ✅ Verification

### Test 1: Check API Key is Loaded

```bash
cd FINAL_NURSERY_BE
node -e "import('dotenv').then(d => { d.default.config(); console.log('API Key:', process.env.GOOGLE_TTS_API_KEY ? '✅ Found (' + process.env.GOOGLE_TTS_API_KEY.substring(0, 20) + '...)' : '❌ Not found'); })"
```

### Test 2: Check FFmpeg

```bash
ffmpeg -version
```

### Test 3: Test the API

```bash
curl 'http://localhost:8000/api/v1/inventory/ram-agri-video-summary?period=day' \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN' \
  -H 'Content-Type: application/json'
```

---

## 🎬 What Gets Generated

### Video File:
- **Format**: MP4 (H.264 + AAC)
- **Resolution**: 1280x720 (HD)
- **Duration**: 20-30 seconds
- **Content**: 
  - Dark blue background
  - Hindi text summary displayed
  - Hindi audio narration playing
- **File Location**: `temp/videos/video-{timestamp}.mp4`

### Video URL:
- Automatically served at: `/api/v1/inventory/videos/{filename}`
- Accessible from frontend
- Can be downloaded or shared

---

## 📊 Free Tier Limits

- **Characters per month**: 0-4 million (FREE)
- **No credit card required** for free tier
- **No expiration** on free tier
- **High quality**: Wavenet voices included
- **Rate limits**: None on free tier

**Example Usage:**
- Average summary: ~500-1000 characters
- Free tier allows: ~4,000-8,000 videos per month
- More than enough for daily/weekly summaries!

---

## 🔄 How It Works

1. **User clicks "Video (Day)" or "Video (Week)"**
2. **Backend generates Hindi text summary**
3. **Google Cloud TTS creates Hindi audio** (FREE)
4. **FFmpeg creates MP4 video** with:
   - Audio track (Hindi narration)
   - Video track (text overlay on background)
5. **Video saved** to `temp/videos/`
6. **Video URL returned** to frontend
7. **Frontend displays video** in modal

---

## 🐛 Troubleshooting

### "GOOGLE_TTS_API_KEY not configured"
- ✅ Check `.env` file has the key
- ✅ Restart server after adding key
- ✅ Verify no typos in key

### "FFmpeg not installed"
- ✅ Install FFmpeg (see Step 7)
- ✅ Verify: `ffmpeg -version`
- ✅ Make sure it's in your PATH

### "API quota exceeded"
- ✅ Check usage: https://console.cloud.google.com/apis/api/texttospeech.googleapis.com/quotas
- ✅ Free tier: 4M chars/month
- ✅ Wait for next month or upgrade

### "Video file not found"
- ✅ Check `temp/videos/` directory exists
- ✅ Check file permissions
- ✅ Verify FFmpeg created the file

### "Video not playing in browser"
- ✅ Check video URL is correct
- ✅ Verify video route is accessible
- ✅ Check browser console for errors
- ✅ Try downloading video directly

---

## 🎯 Quick Reference

**API Key Location:**
- Google Cloud Console → APIs & Services → Credentials

**Enable API:**
- Google Cloud Console → APIs & Services → Library → Text-to-Speech API → Enable

**Check Usage:**
- Google Cloud Console → APIs & Services → Dashboard → Text-to-Speech API

**Free Tier:**
- 4 million characters/month
- No credit card required
- High quality Wavenet voices
- All Hindi voices available

---

## 🚀 You're Ready!

Once you've completed all 8 steps:
1. ✅ Google Cloud project created
2. ✅ Text-to-Speech API enabled
3. ✅ API key generated and added to `.env`
4. ✅ FFmpeg installed
5. ✅ Server restarted

**The video generation will work automatically!**

The system will:
- ✅ Try D-ID first (if configured)
- ✅ Fall back to FREE Google TTS if D-ID fails
- ✅ Generate complete MP4 video files
- ✅ Serve videos through the API
- ✅ Display videos in the frontend modal

**No payment required!** 🎊

---

## 📝 Next Steps

1. Test the video generation from the dashboard
2. Check `temp/videos/` folder for generated videos
3. Monitor usage in Google Cloud Console
4. Enjoy your FREE Hindi video summaries! 🎉
