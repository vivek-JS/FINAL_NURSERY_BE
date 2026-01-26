# 🚀 Next Steps - Video Generation Setup

## ✅ Step 1: API Key Added

Your Google Cloud TTS API key has been added to `.env` file:
```
GOOGLE_TTS_API_KEY=AIzaSyA9KXQ9Q4LAbSK491Rlute9TLIyGdCjxEQ
```

---

## 📋 Step 2: Install FFmpeg

### Check if FFmpeg is installed:
```bash
ffmpeg -version
```

### If not installed:

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
2. Extract and add to PATH

### Verify installation:
```bash
ffmpeg -version
```
You should see version information.

---

## 🔄 Step 3: Restart Your Server

**IMPORTANT**: You must restart the server for the API key to be loaded!

```bash
# Stop your server (Ctrl+C if running)
cd FINAL_NURSERY_BE
npm start
# or
npm run dev
```

---

## ✅ Step 4: Test the Setup

### Test 1: Verify API Key is Loaded
```bash
cd FINAL_NURSERY_BE
node -e "import('dotenv').then(d => { d.default.config(); console.log('API Key:', process.env.GOOGLE_TTS_API_KEY ? '✅ Found' : '❌ Not found'); })"
```

### Test 2: Test Video Generation API
```bash
curl 'http://localhost:8000/api/v1/inventory/ram-agri-video-summary?period=day' \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN' \
  -H 'Content-Type: application/json'
```

### Test 3: Test from Frontend
1. Open Ram Agri Sales Dashboard
2. Click **"Video (Day)"** or **"Video (Week)"** button
3. Wait 10-30 seconds for video generation
4. Video should appear in the modal!

---

## 🎬 What Happens When You Click "Video"

1. **Backend generates Hindi text summary**
2. **Google Cloud TTS creates Hindi audio** (FREE)
3. **FFmpeg creates MP4 video** with:
   - Audio track (Hindi narration)
   - Video track (text overlay on dark blue background)
4. **Video saved** to `temp/videos/video-{timestamp}.mp4`
5. **Video URL returned** to frontend
6. **Frontend displays video** in modal

---

## 📁 Video File Location

Videos are saved to:
```
FINAL_NURSERY_BE/temp/videos/video-{timestamp}.mp4
```

You can:
- Play in browser
- Download
- Share the URL
- Upload to cloud storage (Cloudinary/S3) for permanent hosting

---

## 🐛 Troubleshooting

### "FFmpeg not found"
- Install FFmpeg (see Step 2)
- Verify: `ffmpeg -version`
- Make sure it's in your PATH

### "GOOGLE_TTS_API_KEY not configured"
- Check `.env` file has the key
- Restart server after adding key
- Verify no typos

### "Video generation failed"
- Check server logs for errors
- Verify FFmpeg is installed
- Check API key is valid
- Verify Text-to-Speech API is enabled in Google Cloud

### "Video not playing"
- Check video file exists in `temp/videos/`
- Verify video route is accessible
- Check browser console for errors

---

## ✅ Checklist

- [x] API key added to `.env`
- [ ] FFmpeg installed
- [ ] Server restarted
- [ ] Tested API endpoint
- [ ] Tested from frontend

---

## 🎉 You're Almost There!

Once you:
1. ✅ Install FFmpeg (if not already)
2. ✅ Restart server
3. ✅ Test from dashboard

**Your FREE Hindi video summaries will work!** 🚀

---

## 📞 Need Help?

- Check `GOOGLE_TTS_SETUP_COMPLETE.md` for detailed setup
- Check server logs for errors
- Verify API key at: https://console.cloud.google.com/apis/credentials
