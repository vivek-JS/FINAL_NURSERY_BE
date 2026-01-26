# 🆓 Quick FREE Video Setup Guide

## Setup Google Cloud TTS (FREE - No Credit Card Required!)

### Step 1: Get FREE Google Cloud API Key

1. Go to: https://console.cloud.google.com/
2. Sign in with Google account
3. Create a new project (or use existing)
4. Enable "Cloud Text-to-Speech API":
   - Go to "APIs & Services" > "Library"
   - Search "Text-to-Speech API"
   - Click "Enable"
5. Create API Key:
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "API Key"
   - Copy the key

### Step 2: Install FFmpeg

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
Download from: https://ffmpeg.org/download.html

**Verify installation:**
```bash
ffmpeg -version
```

### Step 3: Add to .env

```bash
GOOGLE_TTS_API_KEY=your_google_cloud_api_key_here
```

### Step 4: Restart Server

```bash
npm start
```

## ✅ That's it! 

The system will automatically:
1. Try D-ID first (if configured)
2. Fall back to FREE Google TTS if D-ID fails or not configured
3. Generate Hindi video with text overlay

## 🎉 Benefits

- ✅ **FREE**: 0-4 million characters/month
- ✅ **No Credit Card**: Required for free tier
- ✅ **High Quality**: Wavenet voices
- ✅ **Hindi Support**: Excellent (hi-IN-Wavenet-A)
- ✅ **Reliable**: Google infrastructure

## 📊 Free Tier Limits

- **Characters**: 0-4 million per month
- **Voices**: All Wavenet voices available
- **Languages**: 40+ languages including Hindi
- **Rate**: No rate limits on free tier

## 🆚 vs D-ID

| Feature | Google TTS (FREE) | D-ID |
|---------|-------------------|------|
| Cost | FREE (4M chars) | Paid |
| Setup | Easy | Easy |
| Quality | High | High |
| Hindi | ✅ Excellent | ✅ Yes |
| Avatar | Text overlay | Talking avatar |

## 💡 Tips

1. **Text Length**: Keep summaries under 5000 characters for best results
2. **FFmpeg**: Make sure it's in your PATH
3. **Storage**: Videos are saved in `temp/videos/` - you can upload to Cloudinary/S3
4. **Cleanup**: Old videos are not auto-deleted - add cleanup job if needed

## 🐛 Troubleshooting

**"FFmpeg not found"**
- Install FFmpeg (see Step 2)
- Verify: `ffmpeg -version`

**"GOOGLE_TTS_API_KEY not configured"**
- Add key to `.env` file
- Restart server

**"API quota exceeded"**
- Free tier: 4M chars/month
- Check usage at: https://console.cloud.google.com/apis/api/texttospeech.googleapis.com/quotas

**Video not playing**
- Check if video file exists in `temp/videos/`
- Verify FFmpeg created the file successfully
- Check server logs for errors

---

**Ready to use!** Just add `GOOGLE_TTS_API_KEY` and install FFmpeg. 🚀
