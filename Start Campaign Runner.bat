@echo off
echo Starting Campaign Runner...
echo Keep this window open. Chrome will open when you click Send All in the app.
echo.
cd /d "%~dp0"
node scripts/campaign-runner-worker.js
pause
