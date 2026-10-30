#!/usr/bin/env bash
# Deploy FINAL_NURSERY_BE to DigitalOcean
# Usage: ./deploy/deploy.sh [user@host]
set -euo pipefail

REMOTE="${1:-root@167.71.232.6}"
APP_DIR="/var/www/FINAL_NURSERY_BE"
BRANCH="${DEPLOY_BRANCH:-prod}"
PM2_NAME="${PM2_NAME:-erp-backend}"

echo "==> Deploy backend -> ${REMOTE}:${APP_DIR} (branch ${BRANCH})"
ssh "$REMOTE" bash -s <<REMOTE_SCRIPT
set -euo pipefail
cd ${APP_DIR}
cp -f .env /tmp/final_nursery_be.env.bak 2>/dev/null || true
git fetch origin
git reset --hard origin/${BRANCH}
cp -f /tmp/final_nursery_be.env.bak .env 2>/dev/null || true

if ! grep -q '^NODE_ENV=' .env 2>/dev/null; then
  echo "NODE_ENV=production" >> .env
else
  sed -i 's/^NODE_ENV=.*/NODE_ENV=production/' .env
fi

# Baileys login lives in MongoDB (whatsapp_session_keys) — no session folder on disk.
# Prefer a stable session id so deploys keep the same linked device.
if ! grep -q '^WHATSAPP_SESSION_ID=' .env 2>/dev/null; then
  echo "WHATSAPP_SESSION_ID=erp-prod" >> .env
fi

export PUPPETEER_SKIP_DOWNLOAD=true
npm install

# Graceful reload (kill_timeout in ecosystem.config.cjs)
if pm2 describe ${PM2_NAME} >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --only ${PM2_NAME} --update-env
else
  pm2 start ecosystem.config.cjs --only ${PM2_NAME} --update-env
fi
pm2 save
pm2 status ${PM2_NAME}
REMOTE_SCRIPT

echo "==> Done. API should be live on the droplet."
