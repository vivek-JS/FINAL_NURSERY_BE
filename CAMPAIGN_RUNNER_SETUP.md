# Campaign Runner - Setup for Non-Technical Users

When the app runs on a production server (no display), WhatsApp campaigns need to run on a computer with Chrome. The **Campaign Runner** does this automatically.

## Server Setup (Admin - One Time)

Add to production server `.env`:
```
CAMPAIGN_WORKER_SECRET=choose-a-random-secret-string-here
```
Do NOT set `API_RUN_CAMPAIGN` on production (so it uses the queue).

## One-Time Setup (User's Computer)

### 1. Get the secret from your admin

Ask your admin for the **Campaign Worker Secret** (same as `CAMPAIGN_WORKER_SECRET` on the server).

### 2. Create a config file

On the computer that will run campaigns (e.g. office laptop):

1. Copy the `FINAL_NURSERY_BE` folder to the computer (or clone the repo).
2. Create or edit `.env` in that folder with:

```
API_URL=https://api1.rambiotechplants.com
CAMPAIGN_WORKER_SECRET=your-secret-from-admin
MONGO_URL=your-production-mongodb-url
```

### 3. Install Node.js (if not installed)

- Download from https://nodejs.org (LTS version)
- Install it
- Restart the computer

### 4. Install Chrome

- Download from https://google.com/chrome
- Install it

## Daily Use

### Start the Campaign Runner

**Option A - Double-click (Windows):**
- Double-click `Start Campaign Runner.bat`

**Option B - Double-click (Mac):**
- Double-click `Start Campaign Runner.command`

**Option C - From terminal:**
```bash
cd FINAL_NURSERY_BE
npm run campaign-runner
```

### What happens

1. A window opens saying "Campaign Runner - Keep this window open"
2. **Keep this window open** (you can minimize it)
3. When someone clicks "Send All" in the app, within ~15 seconds Chrome will open on this computer
4. Log in to WhatsApp Web (scan QR) the first time
5. Messages send automatically
6. When done, Chrome stays open. Close it manually or leave it for the next campaign.

### Important

- Do NOT close the Campaign Runner window
- Do NOT close Chrome when a campaign is running
- You can minimize both windows
- The computer must stay on and connected to the internet
