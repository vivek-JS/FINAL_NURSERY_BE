# How to Generate Google Cloud TTS API Key (FREE)

## 🆓 Complete Step-by-Step Guide

### Step 1: Create Google Cloud Account

1. Go to: **https://console.cloud.google.com/**
2. Sign in with your Google account (Gmail)
3. If you don't have a Google account, create one (it's free)

### Step 2: Create a New Project

1. Click on the **project dropdown** at the top (next to "Google Cloud")
2. Click **"New Project"**
3. Enter project name: `Ram Agri Video` (or any name)
4. Click **"Create"**
5. Wait for project creation (takes 10-20 seconds)
6. Select the new project from dropdown

### Step 3: Enable Text-to-Speech API

1. In the left sidebar, click **"APIs & Services"** > **"Library"**
2. In the search bar, type: **"Text-to-Speech API"**
3. Click on **"Cloud Text-to-Speech API"**
4. Click the **"Enable"** button
5. Wait for activation (takes 5-10 seconds)

### Step 4: Create API Key

1. In the left sidebar, go to **"APIs & Services"** > **"Credentials"**
2. Click **"+ CREATE CREDENTIALS"** at the top
3. Select **"API key"** from dropdown
4. Your API key will be generated immediately
5. **IMPORTANT**: Copy the API key now (you'll see it only once)
   - It looks like: `AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz1234567`

### Step 5: (Optional) Restrict API Key (Recommended for Security)

1. Click **"Restrict key"** button (or edit the key)
2. Under **"API restrictions"**:
   - Select **"Restrict key"**
   - Check **"Cloud Text-to-Speech API"**
   - Click **"Save"**
3. Under **"Application restrictions"** (optional):
   - You can restrict by IP or HTTP referrer for extra security
   - For development, you can skip this

### Step 6: Add to Your .env File

1. Open your `.env` file in the backend:
   ```bash
   nano FINAL_NURSERY_BE/.env
   # or use your preferred editor
   ```

2. Add this line:
   ```bash
   GOOGLE_TTS_API_KEY=AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz1234567
   ```
   (Replace with your actual API key)

3. Save the file

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
2. Extract and add to PATH

**Verify installation:**
```bash
ffmpeg -version
```

### Step 8: Restart Your Server

```bash
# Stop server (Ctrl+C) and restart
cd FINAL_NURSERY_BE
npm start
```

---

## ✅ Verification

### Test the Setup:

1. **Check API key is loaded:**
   ```bash
   cd FINAL_NURSERY_BE
   node -e "import('dotenv').then(d => { d.default.config(); console.log('API Key:', process.env.GOOGLE_TTS_API_KEY ? '✅ Found' : '❌ Not found'); })"
   ```

2. **Test FFmpeg:**
   ```bash
   ffmpeg -version
   ```

3. **Test the API:**
   ```bash
   curl 'http://localhost:8000/api/v1/inventory/ram-agri-video-summary?period=day' \
     -H 'Authorization: Bearer YOUR_JWT_TOKEN'
   ```

---

## 📊 Free Tier Limits

- **Characters per month**: 0-4 million (FREE)
- **No credit card required** for free tier
- **No expiration** on free tier
- **High quality**: Wavenet voices included

---

## 🔒 Security Best Practices

1. **Restrict API Key**: Only allow Text-to-Speech API
2. **Don't commit to Git**: Add `.env` to `.gitignore`
3. **Use environment variables**: Never hardcode in code
4. **Monitor usage**: Check usage at https://console.cloud.google.com/apis/api/texttospeech.googleapis.com/quotas

---

## 🐛 Troubleshooting

### "API key not valid"
- Check if you copied the full key
- Verify key is in `.env` file
- Restart server after adding key

### "API not enabled"
- Go to APIs & Services > Library
- Search "Text-to-Speech API"
- Click "Enable"

### "Quota exceeded"
- Free tier: 4M characters/month
- Check usage in Google Cloud Console
- Wait for next month or upgrade plan

### "FFmpeg not found"
- Install FFmpeg (see Step 7)
- Verify: `ffmpeg -version`
- Make sure it's in your PATH

---

## 📝 Quick Reference

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

---

## 🎉 You're All Set!

Once you've:
1. ✅ Created Google Cloud project
2. ✅ Enabled Text-to-Speech API
3. ✅ Generated API key
4. ✅ Added to `.env` file
5. ✅ Installed FFmpeg
6. ✅ Restarted server

The video generation will work automatically! The system will:
- Try D-ID first (if configured)
- Fall back to FREE Google TTS if D-ID fails
- Generate complete MP4 video files with Hindi narration

**No payment required!** 🎊
