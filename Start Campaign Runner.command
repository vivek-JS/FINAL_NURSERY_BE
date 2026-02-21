#!/bin/bash
cd "$(dirname "$0")"
echo "Starting Campaign Runner..."
echo "Keep this window open. Chrome will open when you click Send All in the app."
echo ""
node scripts/campaign-runner-worker.js
read -p "Press Enter to close..."
