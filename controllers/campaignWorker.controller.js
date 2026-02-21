import archiver from "archiver";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Download Campaign Runner package - pre-configured with server URL. User extracts, runs npm install, adds secret. */
export const downloadCampaignRunner = async (req, res, next) => {
  let tempDir;
  try {
    const baseUrl = process.env.API_URL || `${req.protocol || "https"}://${req.get("host") || "api1.rambiotechplants.com"}`;
    const apiUrl = baseUrl.replace(/\/+$/, "");

    tempDir = path.join(os.tmpdir(), `campaign-runner-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const pkgDir = path.join(tempDir, "CampaignRunner");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(path.join(pkgDir, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(pkgDir, "models"), { recursive: true });

    const root = path.join(__dirname, "..");
    const copy = (src, dest) => {
      const c = fs.readFileSync(src, "utf8");
      fs.writeFileSync(dest, c);
    };

    copy(path.join(root, "scripts", "campaign-runner-worker.js"), path.join(pkgDir, "scripts", "campaign-runner-worker.js"));
    copy(path.join(root, "scripts", "run-campaign-now.js"), path.join(pkgDir, "scripts", "run-campaign-now.js"));
    copy(path.join(root, "scripts", "whatsapp-selenium.js"), path.join(pkgDir, "scripts", "whatsapp-selenium.js"));

    for (const m of ["campaign.model.js", "campaignMedia.model.js", "sendEvent.model.js", "farmer.model.js", "farmerLead.model.js"]) {
      copy(path.join(root, "models", m), path.join(pkgDir, "models", m));
    }

    const envContent = `# Campaign Runner - Edit and add your values
API_URL=${apiUrl}
CAMPAIGN_WORKER_SECRET=ask-admin-for-this
MONGO_URL=ask-admin-for-mongodb-url
DB_NAME=nursery
`;
    fs.writeFileSync(path.join(pkgDir, ".env"), envContent);

    const pkgJson = {
      name: "campaign-runner",
      type: "module",
      dependencies: {
        dotenv: "^16.4.5",
        mongoose: "^7.8.9",
        "selenium-webdriver": "^4.40.0",
      },
    };
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(pkgJson, null, 2));

    fs.writeFileSync(
      path.join(pkgDir, "Start.bat"),
      `@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  echo Installing... Please wait.
  call npm install
  echo.
)
echo Starting Campaign Runner...
node scripts/campaign-runner-worker.js
pause
`
    );

    fs.writeFileSync(
      path.join(pkgDir, "Start.command"),
      `#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d "node_modules" ]; then
  echo "Installing... Please wait."
  npm install
  echo ""
fi
echo "Starting Campaign Runner..."
node scripts/campaign-runner-worker.js
read -p "Press Enter to close..."
`
    );

    fs.writeFileSync(
      path.join(pkgDir, "README.txt"),
      `Campaign Runner - Setup

1. Edit .env file - add:
   - CAMPAIGN_WORKER_SECRET (get from admin)
   - MONGO_URL (get from admin)

2. Double-click Start.bat (Windows) or Start.command (Mac)
   - First run will install (takes 1-2 min)
   - Keep the window open

3. When you click "Send All" in the app, Chrome will open here automatically.
`
    );

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="CampaignRunner.zip"');

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);
    archive.directory(pkgDir, "CampaignRunner");
    await archive.finalize();

    setTimeout(() => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {}
    }, 5000);
  } catch (err) {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {}
    }
    next(err);
  }
};
