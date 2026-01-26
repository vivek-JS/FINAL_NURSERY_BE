# 🔧 Enable Text-to-Speech API

## ❌ Current Issue

The Google Cloud Text-to-Speech API is **not enabled** in your project.

**Error Message:**
```
Cloud Text-to-Speech API has not been used in project 815179027284 before or it is disabled.
```

---

## ✅ Quick Fix (2 minutes)

### Step 1: Enable the API

Click this link to enable the API directly:
👉 **https://console.developers.google.com/apis/api/texttospeech.googleapis.com/overview?project=815179027284**

Or follow these steps:

1. Go to: **https://console.cloud.google.com/apis/library/texttospeech.googleapis.com**
2. Select your project (or create one if needed)
3. Click **"Enable"** button
4. Wait 1-2 minutes for the API to activate

---

### Step 2: Verify API Key

1. Go to: **https://console.cloud.google.com/apis/credentials**
2. Find your API key: `AIzaSyA9KXQ9Q4LAbSK4...`
3. Make sure it has **"Cloud Text-to-Speech API"** enabled
4. If not, click "Edit" and enable it

---

### Step 3: Test Again

After enabling the API, wait 1-2 minutes, then run:

```bash
cd FINAL_NURSERY_BE
node test-video-direct.js
```

---

## 📋 Alternative: Enable via Command Line

If you have `gcloud` CLI installed:

```bash
gcloud services enable texttospeech.googleapis.com --project=815179027284
```

---

## ✅ After Enabling

Once enabled, you should see:
- ✅ API enabled in Google Cloud Console
- ✅ Video generation working
- ✅ Hindi audio generated successfully
- ✅ MP4 video created

---

## 🎬 Next Steps

1. **Enable the API** (link above)
2. **Wait 1-2 minutes** for activation
3. **Test video generation**:
   ```bash
   node test-video-direct.js
   ```
4. **Test from dashboard**: Click "Video (Day)" or "Video (Week)" button

---

## 💡 Free Tier Limits

- **0-4 million characters/month**: FREE
- **After 4M chars**: $4 per 1M characters
- Your typical video: ~500-1000 characters
- **You can generate ~4000-8000 videos/month for FREE!**

---

**Once you enable the API, video generation will work!** 🚀
